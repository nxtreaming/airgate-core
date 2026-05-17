package plugin

import (
	"context"
	"testing"
	"time"

	"entgo.io/ent/dialect/sql/schema"
	_ "github.com/mattn/go-sqlite3"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/DouDOU-start/airgate-core/ent/enttest"
	sdk "github.com/DouDOU-start/airgate-sdk/sdkgo"
)

func TestHostForwardTimeout(t *testing.T) {
	cases := []struct {
		name string
		req  hostForwardRequest
		want time.Duration
	}{
		{name: "empty request", req: hostForwardRequest{}, want: defaultHostForwardTimeout},
		{name: "chat request", req: hostForwardRequest{Path: "/v1/chat/completions", Model: "gpt-4o"}, want: defaultHostForwardTimeout},
		{name: "images API request", req: hostForwardRequest{Path: "/v1/images/generations", Model: "gpt-4o"}, want: imageHostForwardTimeout},
		{name: "image model request", req: hostForwardRequest{Path: "/v1/responses", Model: "gpt-image-2"}, want: imageHostForwardTimeout},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hostForwardTimeout(tc.req); got != tc.want {
				t.Fatalf("hostForwardTimeout() = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestHostForwardReasoningEffort(t *testing.T) {
	t.Parallel()

	req := hostForwardRequest{
		Body: []byte(`{"model":"gpt-5","reasoning":{"effort":"x-high"}}`),
		Headers: map[string]interface{}{
			"Content-Type": []string{"application/json"},
		},
	}

	if got := hostForwardReasoningEffort(req); got != "xhigh" {
		t.Fatalf("hostForwardReasoningEffort() = %q, want %q", got, "xhigh")
	}
}

func TestHostInvokeRequiresDeclaredCapability(t *testing.T) {
	handle := &pluginHostHandle{pluginName: "test-plugin"}
	if err := handle.requireMethod(hostMethodTasksCreate); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected unbound capabilities to be denied, got %v", err)
	}

	handle.SetCapabilities(map[sdk.Capability]bool{})
	if err := handle.requireMethod(hostMethodTasksCreate); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected empty capabilities to be denied, got %v", err)
	}

	handle.SetCapabilities(map[sdk.Capability]bool{
		sdk.CapabilityForHostMethod(hostMethodTasksCreate): true,
	})
	if err := handle.requireMethod(hostMethodTasksCreate); err != nil {
		t.Fatalf("expected declared method capability to pass, got %v", err)
	}
}

func TestTaskPublicIDIsIndependentFromIdempotencyKey(t *testing.T) {
	ctx := context.Background()
	db := enttest.Open(t, "sqlite3", "file:task_public_id?mode=memory&cache=shared&_fk=1", enttest.WithMigrateOptions(schema.WithGlobalUniqueID(false)))
	t.Cleanup(func() { _ = db.Close() })

	host := &HostService{db: db}
	baseReq := hostCreateTaskRequest{
		UserID:         42,
		Input:          map[string]interface{}{"prompt": "test"},
		IdempotencyKey: "same-idempotency-key",
	}
	if _, err := host.createTask(ctx, "gateway-openai", hostCreateTaskRequest{
		UserID:         baseReq.UserID,
		TaskType:       "image.generate",
		Input:          baseReq.Input,
		PublicTaskID:   "pub-generate",
		IdempotencyKey: baseReq.IdempotencyKey,
	}); err != nil {
		t.Fatalf("create generate task: %v", err)
	}
	if _, err := host.createTask(ctx, "gateway-openai", hostCreateTaskRequest{
		UserID:         baseReq.UserID,
		TaskType:       "image.edit",
		Input:          baseReq.Input,
		PublicTaskID:   "pub-edit",
		IdempotencyKey: baseReq.IdempotencyKey,
	}); err != nil {
		t.Fatalf("create edit task with same idempotency key: %v", err)
	}

	got, err := host.getTask(ctx, "gateway-openai", hostGetTaskRequest{UserID: baseReq.UserID, PublicTaskID: "pub-edit"})
	if err != nil {
		t.Fatalf("get task by public id: %v", err)
	}
	task, ok := got["task"].(map[string]interface{})
	if !ok {
		t.Fatalf("task payload type = %T", got["task"])
	}
	if task["task_type"] != "image.edit" || task["public_task_id"] != "pub-edit" {
		t.Fatalf("unexpected task payload: %+v", task)
	}

	_, err = host.getTask(ctx, "gateway-openai", hostGetTaskRequest{UserID: baseReq.UserID, PublicTaskID: baseReq.IdempotencyKey})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("idempotency key should not be usable as public task id, got %v", err)
	}
}

func TestListTasksFiltersByPluginID(t *testing.T) {
	ctx := context.Background()
	db := enttest.Open(t, "sqlite3", "file:list_tasks_plugin_id?mode=memory&cache=shared&_fk=1", enttest.WithMigrateOptions(schema.WithGlobalUniqueID(false)))
	t.Cleanup(func() { _ = db.Close() })

	host := &HostService{db: db}
	for _, pluginID := range []string{"gateway-openai", "other-plugin"} {
		if _, err := host.createTask(ctx, pluginID, hostCreateTaskRequest{
			UserID:   42,
			TaskType: "image.generate",
			Input:    map[string]interface{}{"prompt": pluginID},
		}); err != nil {
			t.Fatalf("create task for %s: %v", pluginID, err)
		}
	}

	got, err := host.listTasks(ctx, "airgate-studio", hostListTasksRequest{
		PluginID: "gateway-openai",
		UserID:   42,
		Limit:    20,
	})
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	tasks, ok := got["tasks"].([]map[string]interface{})
	if !ok {
		t.Fatalf("tasks payload type = %T", got["tasks"])
	}
	if len(tasks) != 1 {
		t.Fatalf("tasks len = %d, want 1: %+v", len(tasks), tasks)
	}
	if tasks[0]["plugin_id"] != "gateway-openai" {
		t.Fatalf("plugin_id = %v, want gateway-openai", tasks[0]["plugin_id"])
	}
}

func TestCheckHostForwardBalance(t *testing.T) {
	ctx := context.Background()
	db := enttest.Open(t, "sqlite3", "file:host_forward_balance?mode=memory&cache=shared&_fk=1", enttest.WithMigrateOptions(schema.WithGlobalUniqueID(false)))
	t.Cleanup(func() { _ = db.Close() })

	zeroBalanceUser := db.User.Create().SetEmail("zero@example.com").SetPasswordHash("hash").SetBalance(0).SaveX(ctx)
	positiveBalanceUser := db.User.Create().SetEmail("positive@example.com").SetPasswordHash("hash").SetBalance(1).SaveX(ctx)

	host := &HostService{db: db}

	if err := host.checkHostForwardBalance(ctx, int64(zeroBalanceUser.ID)); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("expected ResourceExhausted for zero balance, got %v", err)
	}
	if err := host.checkHostForwardBalance(ctx, int64(positiveBalanceUser.ID)); err != nil {
		t.Fatalf("expected positive balance user to pass, got %v", err)
	}
}
