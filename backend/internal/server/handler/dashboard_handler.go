package handler

import (
	"log/slog"

	"github.com/gin-gonic/gin"

	appdashboard "github.com/DouDOU-start/airgate-core/internal/app/dashboard"
	"github.com/DouDOU-start/airgate-core/internal/server/middleware"
)

// DashboardHandler 仪表盘 Handler。
type DashboardHandler struct {
	service *appdashboard.Service
}

// NewDashboardHandler 创建 DashboardHandler。
func NewDashboardHandler(service *appdashboard.Service) *DashboardHandler {
	return &DashboardHandler{service: service}
}

func ensureAdminRole(c *gin.Context) bool {
	if middleware.APIKeySessionID(c) > 0 {
		return false
	}
	role, _ := c.Get("role")
	return role == "admin"
}

func (h *DashboardHandler) handleError(logMessage string, err error) {
	slog.Error(logMessage, "error", err)
}
