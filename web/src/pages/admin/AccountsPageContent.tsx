import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertDialog, Button, Chip, Dropdown, EmptyState, Input, Label, ListBox, Select, Spinner, TextField as HeroTextField } from '@heroui/react';
import {
  Plus,
  Pencil,
  Trash2,
  Zap,
  MoreHorizontal,
  BarChart3,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Search,
  Download,
  Upload,
  Eraser,
} from 'lucide-react';
import { useToast } from '../../shared/ui';
import { PlatformIcon } from '../../shared/ui';
import { accountsApi } from '../../shared/api/accounts';
import { groupsApi } from '../../shared/api/groups';
import { proxiesApi } from '../../shared/api/proxies';
import { AccountTestModal } from './AccountTestModal';
import { AccountStatsModal } from './AccountStatsModal';
import { usePlatforms } from '../../shared/hooks/usePlatforms';
import {
  getAccountIdentityVersion,
  getPluginAccountIdentity,
  getPluginUsageWindow,
  getUsageWindowVersion,
  subscribeAccountIdentityChange,
  subscribeUsageWindowChange,
} from '../../app/plugin-frontend-registry';
import { useCrudMutation } from '../../shared/hooks/useCrudMutation';
import { useDebouncedValue } from '../../shared/hooks/useDebouncedValue';
import { usePagination } from '../../shared/hooks/usePagination';
import { queryKeys } from '../../shared/queryKeys';
import { PAGE_SIZE_OPTIONS, FETCH_ALL_PARAMS } from '../../shared/constants';
import { getTotalPages } from '../../shared/utils/pagination';
import { TablePaginationFooter } from '../../shared/components/TablePaginationFooter';
import { NativeSwitch } from '../../shared/components/NativeSwitch';
import { CreateAccountModal } from './accounts/CreateAccountModal';
import { EditAccountModal } from './accounts/EditAccountModal';
import { BulkActionsBar } from './accounts/BulkActionsBar';
import { BulkEditAccountModal } from './accounts/BulkEditAccountModal';
import { BulkRefreshProgressModal } from './accounts/BulkRefreshProgressModal';
import type {
  AccountResp,
  CreateAccountReq,
  UpdateAccountReq,
  BulkUpdateAccountsReq,
  BulkOpResp,
  AccountExportFile,
  AccountExportItem,
  PagedData,
} from '../../shared/types';

interface AccountTableColumn {
  key: string;
  title: ReactNode;
  width?: string;
  mobileWidth?: string;
  maxWidth?: string;
  align?: 'left' | 'center' | 'right';
  render: (row: AccountResp) => ReactNode;
}

const UNGROUPED_GROUP_FILTER = '__ungrouped__';
type SelectionListener = () => void;
type AccountTypeFilterOption = {
  id: string;
  label: string;
  planLabel?: string;
  platformLabel?: string;
};
type AccountUsageTodayStats = { requests: number; tokens: number; account_cost: number; user_cost: number };
type AccountUsageCredits = { balance: number; unlimited: boolean };
type AccountUsageWindow = {
  key?: string;
  label: string;
  used_percent: number;
  reset_at?: string;
  reset_after_seconds?: number;
  reset_seconds?: number;
};
type AccountUsageInfo = {
  windows?: AccountUsageWindow[];
  credits?: AccountUsageCredits | null;
  today_stats?: AccountUsageTodayStats | null;
  updated_at?: string;
};
type AccountUsageData = { accounts?: Record<string, AccountUsageInfo> };
type CachedUsageWindow = {
  resetAtMs: number;
  usedPercent: number;
  window: AccountUsageWindow;
};
type AccountUsageWindowCache = Map<string, CachedUsageWindow>;

function renderAccountTypeFilterOption(option: AccountTypeFilterOption, showOAuthLabel = true): ReactNode {
  if (!option.planLabel) return option.label;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {option.platformLabel ? <span className="truncate">{option.platformLabel}</span> : null}
      {showOAuthLabel ? <span className="truncate">OAuth</span> : null}
      <Chip color="accent" size="sm" variant="soft">
        {option.planLabel}
      </Chip>
    </span>
  );
}

function getUsageWindowIdentity(window: AccountUsageWindow) {
  const key = window.key?.trim();
  if (key) return key;
  return window.label.trim();
}

function getUsageWindowCacheKey(accountId: string, window: AccountUsageWindow) {
  return `${accountId}:${getUsageWindowIdentity(window)}`;
}

function getUsageWindowResetAtMs(window: AccountUsageWindow, now: number) {
  if (window.reset_at) {
    const parsed = Date.parse(window.reset_at);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  const resetSeconds = Number(window.reset_seconds ?? 0);
  if (resetSeconds > 0) return now + resetSeconds * 1000;
  const resetAfterSeconds = Number(window.reset_after_seconds ?? 0);
  if (resetAfterSeconds > 0) return now + resetAfterSeconds * 1000;
  return 0;
}

function getUsageWindowUsedPercent(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function windowWithCachedReset(window: AccountUsageWindow, resetAtMs: number, now: number): AccountUsageWindow {
  if (resetAtMs <= now) {
    return {
      ...window,
      reset_seconds: 0,
    };
  }
  return {
    ...window,
    reset_at: new Date(resetAtMs).toISOString(),
    reset_seconds: Math.max(0, Math.ceil((resetAtMs - now) / 1000)),
  };
}

function mergeCachedUsageWindows(data: AccountUsageData | undefined, cache: AccountUsageWindowCache): AccountUsageData | undefined {
  if (!data?.accounts) return data;

  const now = Date.now();
  const accounts: Record<string, AccountUsageInfo> = {};
  const liveCacheKeys = new Set<string>();

  for (const [accountId, usage] of Object.entries(data.accounts)) {
    const rawWindows = Array.isArray(usage?.windows) ? usage.windows : [];
    const mergedWindows: AccountUsageWindow[] = [];

    for (const window of rawWindows) {
      const cacheKey = getUsageWindowCacheKey(accountId, window);
      const resetAtMs = getUsageWindowResetAtMs(window, now);
      const cached = cache.get(cacheKey);
      const usedPercent = getUsageWindowUsedPercent(window.used_percent)
        ?? cached?.usedPercent
        ?? 0;
      const effectiveResetAtMs = resetAtMs > now
        ? resetAtMs
        : cached && cached.resetAtMs > now
          ? cached.resetAtMs
          : 0;
      const windowWithCachedUsage = {
        ...window,
        used_percent: usedPercent,
      };
      const nextWindow = effectiveResetAtMs > now
        ? windowWithCachedReset(windowWithCachedUsage, effectiveResetAtMs, now)
        : {
            ...windowWithCachedUsage,
            reset_seconds: Number(window.reset_seconds ?? 0),
          };

      cache.set(cacheKey, {
        resetAtMs: effectiveResetAtMs > now ? effectiveResetAtMs : 0,
        usedPercent,
        window: nextWindow,
      });
      liveCacheKeys.add(cacheKey);
      mergedWindows.push(nextWindow);
    }

    accounts[accountId] = {
      ...usage,
      windows: mergedWindows,
    };
  }

  for (const cacheKey of cache.keys()) {
    if (!liveCacheKeys.has(cacheKey)) {
      cache.delete(cacheKey);
    }
  }

  return {
    ...data,
    accounts,
  };
}

function runAfterInputFrame(work: () => void) {
  if (typeof window === 'undefined') {
    startTransition(work);
    return;
  }

  window.requestAnimationFrame(() => {
    window.setTimeout(() => startTransition(work), 0);
  });
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

class AccountSelectionStore {
  private selectedIds = new Set<number>();
  private version = 0;
  private listeners = new Set<SelectionListener>();
  private rowListeners = new Map<number, Set<SelectionListener>>();

  subscribe = (listener: SelectionListener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  subscribeRow = (id: number, listener: SelectionListener) => {
    let listeners = this.rowListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.rowListeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.rowListeners.delete(id);
      }
    };
  };

  getSnapshot = () => this.version;

  has(id: number) {
    return this.selectedIds.has(id);
  }

  getSelectedIds() {
    return Array.from(this.selectedIds);
  }

  countVisible(ids: number[]) {
    let count = 0;
    for (const id of ids) {
      if (this.selectedIds.has(id)) count += 1;
    }
    return count;
  }

  setRow(id: number, isSelected: boolean) {
    const alreadySelected = this.selectedIds.has(id);
    if (alreadySelected === isSelected) return;

    if (isSelected) {
      this.selectedIds.add(id);
    } else {
      this.selectedIds.delete(id);
    }
    this.notify([id]);
  }

  setRows(ids: number[], isSelected: boolean) {
    const changedIds: number[] = [];
    for (const id of ids) {
      const alreadySelected = this.selectedIds.has(id);
      if (alreadySelected === isSelected) continue;
      if (isSelected) {
        this.selectedIds.add(id);
      } else {
        this.selectedIds.delete(id);
      }
      changedIds.push(id);
    }
    if (changedIds.length > 0) {
      this.notify(changedIds);
    }
  }

  clear() {
    if (this.selectedIds.size === 0) return;
    const changedIds = Array.from(this.selectedIds);
    this.selectedIds.clear();
    this.notify(changedIds);
  }

  private notify(changedIds: number[]) {
    this.version += 1;
    for (const id of changedIds) {
      this.rowListeners.get(id)?.forEach((listener) => listener());
    }
    this.listeners.forEach((listener) => listener());
  }
}

function StatusPill({ status, tooltip }: { status: 'active' | 'disabled'; tooltip?: string }) {
  const { t } = useTranslation();
  const chip = (
    <Chip color={status === 'active' ? 'success' : 'default'} size="sm" variant="soft">
      {status === 'active' ? t('status.active') : t('status.disabled')}
    </Chip>
  );

  if (!tooltip) return chip;
  return <span className="inline-flex" title={tooltip}>{chip}</span>;
}

function TableSelectionCheckbox({
  ariaLabel,
  isIndeterminate,
  isSelected,
  onChange,
}: {
  ariaLabel: string;
  isIndeterminate?: boolean;
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = !!isIndeterminate;
    }
  }, [isIndeterminate]);

  return (
    <input
      ref={checkboxRef}
      type="checkbox"
      aria-label={ariaLabel}
      checked={isSelected}
      className="ag-table-selection-checkbox"
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

function columnAlignClass(align?: AccountTableColumn['align']) {
  if (align === 'right') return 'text-right';
  if (align === 'left') return 'text-left';
  return 'text-center';
}

function cellJustifyClass(align?: AccountTableColumn['align']) {
  if (align === 'right') return 'justify-end';
  if (align === 'left') return 'justify-start';
  return 'justify-center';
}

const ACCOUNT_SELECTION_COLUMN_STYLE: CSSProperties = {
  minWidth: 'var(--ag-accounts-selection-column-width)',
  width: 'var(--ag-accounts-selection-column-width)',
};

function columnWidthStyle(column: AccountTableColumn): CSSProperties | undefined {
  if (!column.width) return undefined;
  const width = column.mobileWidth
    ? `var(--ag-accounts-col-${column.key}-width, ${column.width})`
    : column.width;
  return {
    minWidth: width,
    width,
    maxWidth: column.maxWidth,
  };
}

const AccountRowSelectionCell = memo(function AccountRowSelectionCell({
  ariaLabel,
  selectionStore,
  rowId,
  onSelectedChange,
}: {
  ariaLabel: string;
  selectionStore: AccountSelectionStore;
  rowId: number;
  onSelectedChange: (id: number, isSelected: boolean) => void;
}) {
  const isSelected = useSyncExternalStore(
    useCallback((listener) => selectionStore.subscribeRow(rowId, listener), [rowId, selectionStore]),
    useCallback(() => selectionStore.has(rowId), [rowId, selectionStore]),
    () => false,
  );
  const handleChange = useCallback((nextSelected: boolean) => {
    onSelectedChange(rowId, nextSelected);
  }, [onSelectedChange, rowId]);

  return (
    <div className="inline-flex" onClick={(event) => event.stopPropagation()}>
      <TableSelectionCheckbox
        ariaLabel={ariaLabel}
        isSelected={isSelected}
        onChange={handleChange}
      />
    </div>
  );
});

const AccountTableCellContent = memo(function AccountTableCellContent({
  column,
  row,
}: {
  column: AccountTableColumn;
  row: AccountResp;
}) {
  return (
    <div className={`flex w-full min-w-0 items-center ${cellJustifyClass(column.align)}`}>
      {column.render(row)}
    </div>
  );
}, (prev, next) => prev.column === next.column && prev.row === next.row);

const AccountSchedulingSwitch = memo(function AccountSchedulingSwitch({
  ariaLabel,
  isSelected,
  rowId,
  onToggle,
}: {
  ariaLabel: string;
  isSelected: boolean;
  rowId: number;
  onToggle: (id: number) => void;
}) {
  const handleClick = useCallback(() => {
    onToggle(rowId);
  }, [onToggle, rowId]);

  return (
    <NativeSwitch
      ariaLabel={ariaLabel}
      isSelected={isSelected}
      onChange={handleClick}
    />
  );
}, (prev, next) => (
  prev.ariaLabel === next.ariaLabel
  && prev.isSelected === next.isSelected
  && prev.rowId === next.rowId
  && prev.onToggle === next.onToggle
));

const AccountRowActions = memo(function AccountRowActions({
  row,
  labels,
  onEdit,
  onDelete,
  onTest,
  onStats,
  onRefreshQuota,
  onClearCooldowns,
}: {
  row: AccountResp;
  labels: {
    actions: string;
    clearCooldowns: string;
    delete: string;
    edit: string;
    more: string;
    refreshQuota: string;
    stats: string;
    test: string;
  };
  onEdit: (row: AccountResp) => void;
  onDelete: (row: AccountResp) => void;
  onTest: (row: AccountResp) => void;
  onStats: (id: number) => void;
  onRefreshQuota: (id: number) => void;
  onClearCooldowns: (id: number) => void;
}) {
  return (
    <div className="ag-table-row-actions ag-account-row-actions mx-auto flex w-[92px] items-center justify-center gap-1">
      <button
        type="button"
        aria-label={labels.edit}
        className="ag-account-row-action-button"
        onClick={(event) => {
          event.stopPropagation();
          onEdit(row);
        }}
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        aria-label={labels.delete}
        className="ag-account-row-action-button ag-account-row-action-button--danger"
        onClick={(event) => {
          event.stopPropagation();
          onDelete(row);
        }}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
      <Dropdown>
        <Dropdown.Trigger
          aria-label={labels.more}
          className="ag-account-row-more-trigger ag-account-row-action-button h-7 w-7 min-w-7"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </Dropdown.Trigger>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={labels.actions}
            onAction={(key) => {
              switch (String(key)) {
                case 'test':
                  onTest(row);
                  break;
                case 'stats':
                  onStats(row.id);
                  break;
                case 'refresh_quota':
                  onRefreshQuota(row.id);
                  break;
                case 'clear_cooldowns':
                  onClearCooldowns(row.id);
                  break;
              }
            }}
          >
            <Dropdown.Item id="test" textValue={labels.test}>
              <span className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5" style={{ color: 'var(--ag-warning)' }} />
                {labels.test}
              </span>
            </Dropdown.Item>
            <Dropdown.Item id="stats" textValue={labels.stats}>
              <span className="flex items-center gap-2">
                <BarChart3 className="w-3.5 h-3.5" style={{ color: 'var(--ag-primary)' }} />
                {labels.stats}
              </span>
            </Dropdown.Item>
            {row.type === 'oauth' ? (
              <Dropdown.Item id="refresh_quota" textValue={labels.refreshQuota}>
                <span className="flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5" style={{ color: 'var(--ag-success)' }} />
                  {labels.refreshQuota}
                </span>
              </Dropdown.Item>
            ) : null}
            <Dropdown.Item id="clear_cooldowns" textValue={labels.clearCooldowns}>
              <span className="flex items-center gap-2">
                <Eraser className="w-3.5 h-3.5" style={{ color: 'var(--ag-warning)' }} />
                {labels.clearCooldowns}
              </span>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}, (prev, next) => (
  prev.row === next.row
  && prev.labels === next.labels
  && prev.onEdit === next.onEdit
  && prev.onDelete === next.onDelete
  && prev.onTest === next.onTest
  && prev.onStats === next.onStats
  && prev.onRefreshQuota === next.onRefreshQuota
  && prev.onClearCooldowns === next.onClearCooldowns
));

const AccountTableRow = memo(function AccountTableRow({
  columns,
  row,
  selectRowAriaLabel,
  selectionStore,
  onSelectedChange,
}: {
  columns: AccountTableColumn[];
  row: AccountResp;
  selectRowAriaLabel: string;
  selectionStore: AccountSelectionStore;
  onSelectedChange: (id: number, isSelected: boolean) => void;
}) {
  return (
    <tr data-slot="tr" data-key={row.id}>
      <td data-slot="td" className="text-center" style={ACCOUNT_SELECTION_COLUMN_STYLE}>
        <AccountRowSelectionCell
          ariaLabel={selectRowAriaLabel}
          rowId={row.id}
          selectionStore={selectionStore}
          onSelectedChange={onSelectedChange}
        />
      </td>
      {columns.map((column) => (
        <td
          data-slot="td"
          key={column.key}
          style={columnWidthStyle(column)}
        >
          <AccountTableCellContent column={column} row={row} />
        </td>
      ))}
    </tr>
  );
}, (prev, next) => (
  prev.columns === next.columns
  && prev.row === next.row
  && prev.selectRowAriaLabel === next.selectRowAriaLabel
  && prev.selectionStore === next.selectionStore
  && prev.onSelectedChange === next.onSelectedChange
));

function AccountsTableLoadingRow({ colSpan, minHeight = 220 }: { colSpan: number; minHeight?: number }) {
  return (
    <tr data-slot="tr" data-key="loading">
      <td data-slot="td" colSpan={colSpan}>
        <div aria-busy="true" aria-live="polite" className="w-full" style={{ minHeight }}>
          <span className="sr-only">Loading</span>
        </div>
      </td>
    </tr>
  );
}

const AutoRefreshCountdownLabel = memo(function AutoRefreshCountdownLabel({
  autoRefresh,
  label,
  offLabel,
  onRefresh,
}: {
  autoRefresh: number;
  label: string;
  offLabel: string;
  onRefresh: () => void;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const renderCountdown = (seconds: number) => {
      if (labelRef.current) {
        labelRef.current.textContent = autoRefresh ? `${label}${seconds}s` : offLabel;
      }
    };

    if (!autoRefresh) {
      renderCountdown(0);
      return undefined;
    }

    let remaining = autoRefresh;
    renderCountdown(remaining);
    const timer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        onRefresh();
        remaining = autoRefresh;
      }
      renderCountdown(remaining);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, label, offLabel, onRefresh]);

  return (
    <span ref={labelRef}>
      {autoRefresh ? `${label}${autoRefresh}s` : offLabel}
    </span>
  );
}, (prev, next) => (
  prev.autoRefresh === next.autoRefresh
  && prev.label === next.label
  && prev.offLabel === next.offLabel
  && prev.onRefresh === next.onRefresh
));

// formatCountdown 把剩余毫秒格式化成 "Xd Yh"/"Xh Ym"/"Ym" 样式，
// 与 sub2api 的"限流中 10h 16m 自动恢复"徽标一致。
function formatCountdown(ms: number): string {
  if (ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

function accountHasLiveCooldown(row: AccountResp, now: number): boolean {
  const stateUntil = row.state_until ? Date.parse(row.state_until) : 0;
  if (stateUntil > now) return true;
  return (row.family_cooldowns || []).some((fc) => Date.parse(fc.until) > now);
}

let cooldownClockNow = Date.now();
let cooldownClockTimer: number | null = null;
const cooldownClockListeners = new Set<() => void>();

function subscribeCooldownClock(listener: () => void) {
  cooldownClockNow = Date.now();
  cooldownClockListeners.add(listener);
  if (cooldownClockTimer == null) {
    cooldownClockTimer = window.setInterval(() => {
      cooldownClockNow = Date.now();
      cooldownClockListeners.forEach((notify) => notify());
    }, 1000);
  }

  return () => {
    cooldownClockListeners.delete(listener);
    if (cooldownClockListeners.size === 0 && cooldownClockTimer != null) {
      window.clearInterval(cooldownClockTimer);
      cooldownClockTimer = null;
    }
  };
}

function subscribeIdleClock() {
  return () => {};
}

function getCooldownClockSnapshot() {
  return cooldownClockNow;
}

function useCooldownClock(enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? subscribeCooldownClock : subscribeIdleClock,
    getCooldownClockSnapshot,
    getCooldownClockSnapshot,
  );
}

/**
 * AccountStatusCell 渲染账号状态徽标，按 state + state_until 动态展示：
 *   active       → 绿色 "活跃"
 *   rate_limited → 橙色 "限流中 Xh Ym"（state_until 倒计时）
 *   degraded     → 黄色 "降级 Xm"（池账号软降级，倒计时）
 *   disabled     → 红色 "已禁用"（tooltip 显示 error_msg）
 * 到期的 rate_limited / degraded 视作 active（后端 lazy 回收，前端可先显示 active）。
 *
 * 同一行还会叠加家族级冷却（family_cooldowns）：账号 state 可能仍是 active，
 * 但某个 family（如 gpt-image）在 Redis 上仍处冷却中。用一个橙色小 pill
 * 标出"限流家族数"，hover tooltip 列出每个家族剩余时间。
 */
function AccountStatusCell({ row }: { row: AccountResp }) {
  const { t } = useTranslation();
  const hasLiveCooldown = accountHasLiveCooldown(row, Date.now());
  const tickingNow = useCooldownClock(hasLiveCooldown);
  const now = hasLiveCooldown ? tickingNow : Date.now();
  const untilMs = row.state_until ? Date.parse(row.state_until) : 0;
  const remainingMs = untilMs - now;
  const hasCountdown = untilMs > 0 && remainingMs > 0;

  // 过滤出仍生效的家族冷却（后端可能返回刚到期的）。
  const liveFamilyCooldowns = (row.family_cooldowns || []).filter(
    (fc) => Date.parse(fc.until) > now,
  );

  const pill = (label: string, bg: string, fg: string, tooltip?: string) => (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border whitespace-nowrap"
      style={{ background: bg, color: fg, borderColor: bg }}
      title={tooltip}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: fg }} />
      {label}
    </span>
  );

  // 主 state 徽标
  let mainBadge: ReactElement;
  if (row.state === 'rate_limited' && hasCountdown) {
    mainBadge = pill(
      `${t('accounts.rate_limited_label', '限流中')} ${formatCountdown(remainingMs)}`,
      'var(--ag-warning-subtle)',
      'var(--ag-warning)',
      t('accounts.rate_limited_tooltip', '上游限流，到期自动恢复，不影响调度开关'),
    );
  } else if (row.state === 'degraded' && hasCountdown) {
    mainBadge = pill(
      `${t('accounts.degraded_label', '降级')} ${formatCountdown(remainingMs)}`,
      'var(--ag-warning-subtle)',
      'var(--ag-warning)',
      t('accounts.degraded_tooltip', '上游池抖动，软降级仅做兜底，到期自动恢复'),
    );
  } else if (row.state === 'disabled') {
    const reason = row.error_msg?.trim() === '管理员手动关闭调度' ? '手动关闭' : row.error_msg?.trim();
    mainBadge = (
      <div className="inline-flex min-w-0 max-w-full flex-col items-center gap-0.5">
        <StatusPill status="disabled" tooltip={reason || undefined} />
        {reason && (
          <span className="block max-w-[5.75rem] truncate text-center text-[10px] leading-none text-[var(--ag-muted)]" title={reason}>
            {reason}
          </span>
        )}
      </div>
    );
  } else {
    // active，或 rate_limited/degraded 已到期（lazy 恢复）
    mainBadge = <StatusPill status="active" />;
  }

  if (liveFamilyCooldowns.length === 0) {
    return mainBadge;
  }

  // tooltip 多行：每个家族 + 剩余时间，rate-limit 原因截断到 80 字符避免过宽
  const familyTooltip = liveFamilyCooldowns
    .map((fc) => {
      const ms = Date.parse(fc.until) - now;
      const reason = fc.reason ? ` — ${fc.reason.slice(0, 80)}` : '';
      return `${fc.family} ${formatCountdown(ms)}${reason}`;
    })
    .join('\n');

  const familyLabel = t(
    'accounts.family_cooldown_label',
    '{{count}} 家族限流',
    { count: liveFamilyCooldowns.length },
  );

  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      {mainBadge}
      {pill(
        familyLabel,
        'var(--ag-warning-subtle)',
        'var(--ag-warning)',
        familyTooltip,
      )}
    </div>
  );
}

function AccountCapacityChip({ current, max }: { current: number; max: number }) {
  const previousCurrentRef = useRef(current);
  const pulseTimerRef = useRef<number | null>(null);
  const [isPulsing, setIsPulsing] = useState(false);
  const [pulseTone, setPulseTone] = useState<'success' | 'warning'>('success');
  const [pulseToken, setPulseToken] = useState(0);
  const state = current <= 0 ? 'idle' : current >= max ? 'full' : 'active';

  useEffect(() => {
    if (previousCurrentRef.current === current) return;
    const previousCurrent = previousCurrentRef.current;
    previousCurrentRef.current = current;

    if (pulseTimerRef.current != null) {
      window.clearTimeout(pulseTimerRef.current);
    }

    setPulseTone(current < previousCurrent ? 'warning' : 'success');
    setIsPulsing(true);
    setPulseToken((token) => token + 1);
    pulseTimerRef.current = window.setTimeout(() => {
      setIsPulsing(false);
      pulseTimerRef.current = null;
    }, 520);
  }, [current]);

  useEffect(() => () => {
    if (pulseTimerRef.current != null) {
      window.clearTimeout(pulseTimerRef.current);
    }
  }, []);

  return (
    <span
      key={pulseToken}
      className="ag-account-capacity"
      data-state={state}
      data-pulse={isPulsing || undefined}
      data-pulse-tone={pulseTone}
      title={`${current} / ${max}`}
    >
      <span className="ag-account-capacity-current">{current}</span>
      <span className="ag-account-capacity-divider">/</span>
      <span className="ag-account-capacity-max">{max}</span>
    </span>
  );
}

export default function AccountsPageContent() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { platforms, platformName: resolvePlatformName, oauthPlanFilters, isLoading: platformsLoading } = usePlatforms();
  const platformNameRef = useLatestRef(resolvePlatformName);
  const platformName = useCallback((platform: string) => platformNameRef.current(platform), [platformNameRef]);
  const platformsKey = platforms.join('\u0000');
  const { toast } = useToast();
  useSyncExternalStore(subscribeAccountIdentityChange, getAccountIdentityVersion);
  useSyncExternalStore(subscribeUsageWindowChange, getUsageWindowVersion);

  const applyQuotaRefreshResult = useCallback((
    id: number,
    result: Awaited<ReturnType<typeof accountsApi.refreshQuota>>,
  ) => {
    queryClient.setQueriesData<PagedData<AccountResp>>(
      { queryKey: queryKeys.accounts() },
      (old) => {
        if (!old?.list?.length) return old;

        let matched = false;
        const list = old.list.map((account) => {
          if (account.id !== id) return account;
          matched = true;
          return {
            ...account,
            credentials: {
              ...account.credentials,
              ...(result.plan_type !== undefined ? { plan_type: result.plan_type } : {}),
              ...(result.email !== undefined ? { email: result.email } : {}),
              ...(result.subscription_active_until !== undefined
                ? { subscription_active_until: result.subscription_active_until }
                : {}),
            },
          };
        });

        return matched ? { ...old, list } : old;
      },
    );
  }, [queryClient]);

  const PLATFORM_OPTIONS = [
    { id: '', label: t('accounts.all_platforms') },
    ...platforms.map((p) => ({ id: p, label: platformName(p) })),
  ];

  const STATE_OPTIONS = [
    { id: '', label: t('users.all_status') },
    { id: 'active', label: t('status.active') },
    { id: 'rate_limited', label: t('status.rate_limited', '限流中') },
    { id: 'degraded', label: t('status.degraded', '降级中') },
    { id: 'disabled', label: t('status.disabled') },
  ];

  // 筛选状态
  const { page, setPage, pageSize, setPageSize } = usePagination(20, 'admin.accounts');
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebouncedValue(keyword.trim(), 250);
  const [platformFilter, setPlatformFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [isTypeMenuOpen, setIsTypeMenuOpen] = useState(false);
  const [isOAuthPlanMenuOpen, setIsOAuthPlanMenuOpen] = useState(false);
  const typeFilterMenuRef = useRef<HTMLDivElement>(null);
  const [groupFilter, setGroupFilter] = useState('');
  const [proxyFilter, setProxyFilter] = useState('');
  const closeTypeFilterMenu = useCallback(() => {
    setIsTypeMenuOpen(false);
    setIsOAuthPlanMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!isTypeMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && typeFilterMenuRef.current?.contains(target)) return;
      closeTypeFilterMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTypeFilterMenu();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeTypeFilterMenu, isTypeMenuOpen]);

  // 自动刷新
  const AUTO_REFRESH_OPTIONS = [0, 5, 10, 15, 30];
  const [autoRefresh, setAutoRefresh] = useState(0); // 秒，0=关闭
  const refreshAccounts = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
  }, [queryClient]);
  const autoRefreshLabel = t('accounts.auto_refresh');
  const autoRefreshOffLabel = t('accounts.auto_refresh_off');

  // 弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AccountResp | null>(null);
  const [deletingAccount, setDeletingAccount] = useState<AccountResp | null>(null);
  const [testingAccount, setTestingAccount] = useState<AccountResp | null>(null);
  const [statsAccountId, setStatsAccountId] = useState<number | null>(null);

  // 批量选择状态
  const selectionStoreRef = useRef<AccountSelectionStore | null>(null);
  if (selectionStoreRef.current === null) {
    selectionStoreRef.current = new AccountSelectionStore();
  }
  const selectionStore = selectionStoreRef.current;
  const selectionVersion = useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSnapshot,
    selectionStore.getSnapshot,
  );
  const selectedIds = useMemo(() => selectionStore.getSelectedIds(), [selectionStore, selectionVersion]);
  const selectedCount = selectedIds.length;
  const [pendingToggleIds, setPendingToggleIds] = useState<Set<number>>(() => new Set());
  const pendingToggleIdsRef = useRef(pendingToggleIds);
  pendingToggleIdsRef.current = pendingToggleIds;
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkRefreshTargets, setBulkRefreshTargets] = useState<{ id: number; name: string }[] | null>(null);
  const clearSelection = useCallback(() => {
    runAfterInputFrame(() => selectionStore.clear());
  }, [selectionStore]);

  // 切换筛选/分页时清空选择，避免不可见行仍被选中导致误操作
  useEffect(() => {
    selectionStore.clear();
  }, [groupFilter, keyword, page, pageSize, platformFilter, proxyFilter, selectionStore, stateFilter, typeFilter]);

  // 查询账号列表
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.accounts(page, pageSize, debouncedKeyword, platformFilter, stateFilter, typeFilter, groupFilter, proxyFilter),
    queryFn: () =>
      accountsApi.list({
        page,
        page_size: pageSize,
        keyword: debouncedKeyword || undefined,
        platform: platformFilter || undefined,
        state: stateFilter || undefined,
        account_type: typeFilter || undefined,
        group_id: groupFilter && groupFilter !== UNGROUPED_GROUP_FILTER ? Number(groupFilter) : undefined,
        ungrouped: groupFilter === UNGROUPED_GROUP_FILTER ? true : undefined,
        proxy_id: proxyFilter ? Number(proxyFilter) : undefined,
      }),
    placeholderData: keepPreviousData,
  });

  // 查询分组列表（用于表格中 ID→名称映射）
  const { data: allGroupsData } = useQuery({
    queryKey: queryKeys.groupsAll(),
    queryFn: () => groupsApi.list(FETCH_ALL_PARAMS),
  });
  const groupMap = useMemo(
    () => new Map((allGroupsData?.list ?? []).map((g) => [g.id, g.name])),
    [allGroupsData?.list],
  );

  // 查询代理列表（用于表格中 ID→名称映射）
  // 代理列表（只用于顶部筛选器；之前的"代理"列已移除）
  const { data: allProxiesData } = useQuery({
    queryKey: queryKeys.proxiesAll(),
    queryFn: () => proxiesApi.list(FETCH_ALL_PARAMS),
  });

  // 查询用量窗口
  const usageWindowCacheRef = useRef<AccountUsageWindowCache>(new Map());
  const { data: rawUsageData } = useQuery({
    queryKey: queryKeys.accountUsage(platformFilter),
    queryFn: () => accountsApi.usage(platformFilter || ''),
    meta: { globalLoading: false },
    refetchInterval: 300_000, // 每 5 分钟刷新
  });
  const usageData = useMemo(
    () => mergeCachedUsageWindows(rawUsageData, usageWindowCacheRef.current),
    [rawUsageData],
  );
  const usageDataRef = useRef(usageData);
  usageDataRef.current = usageData;

  // 创建账号
  const createMutation = useCrudMutation({
    mutationFn: (data: CreateAccountReq) => accountsApi.create(data),
    successMessage: t('accounts.create_success'),
    queryKey: queryKeys.accounts(),
    onSuccess: () => {
      setShowCreateModal(false);
      // 创建账号后立即刷新用量窗口
      queryClient.invalidateQueries({ queryKey: queryKeys.accountUsage(platformFilter) });
    },
  });

  // 导出账号：有选中项时仅导出选中账号；否则按当前筛选条件导出。
  const importInputRef = useRef<HTMLInputElement>(null);
  const exportMutation = useMutation({
    mutationFn: () => {
      if (selectedIds.length > 0) {
        return accountsApi.export({ ids: selectedIds });
      }
      return accountsApi.export({
        keyword: debouncedKeyword || undefined,
        platform: platformFilter || undefined,
        state: stateFilter || undefined,
        account_type: typeFilter || undefined,
        group_id: groupFilter && groupFilter !== UNGROUPED_GROUP_FILTER ? Number(groupFilter) : undefined,
        ungrouped: groupFilter === UNGROUPED_GROUP_FILTER ? true : undefined,
        proxy_id: proxyFilter ? Number(proxyFilter) : undefined,
      });
    },
    onSuccess: (file: AccountExportFile) => {
      // 触发浏览器下载，文件名使用北京时间便于用户辨识。
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
      const ts = `${pick('year')}${pick('month')}${pick('day')}${pick('hour')}${pick('minute')}${pick('second')}`;
      a.href = url;
      a.download = `airgate-accounts-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('success', t('accounts.export_success', { count: file.count }));
    },
    onError: (err: Error) => toast('error', err.message),
  });

  // 导入账号
  const importMutation = useMutation({
    mutationFn: (accounts: AccountExportItem[]) => accountsApi.import(accounts),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
      if (res.failed > 0) {
        toast('warning', t('accounts.import_partial', { imported: res.imported, failed: res.failed }));
      } else {
        toast('success', t('accounts.import_success', { count: res.imported }));
      }
    },
    onError: (err: Error) => toast('error', err.message),
  });

  function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // 重置 input，允许重复选择同一文件
    if (importInputRef.current) importInputRef.current.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const accounts: AccountExportItem[] = Array.isArray(parsed) ? parsed : parsed.accounts;
        if (!Array.isArray(accounts) || accounts.length === 0) {
          toast('error', t('accounts.import_invalid'));
          return;
        }
        importMutation.mutate(accounts);
      } catch {
        toast('error', t('accounts.import_invalid'));
      }
    };
    reader.onerror = () => toast('error', t('accounts.import_invalid'));
    reader.readAsText(file);
  }

  // 更新账号
  const updateMutation = useCrudMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateAccountReq }) =>
      accountsApi.update(id, data),
    successMessage: t('accounts.update_success'),
    queryKey: queryKeys.accounts(),
    onSuccess: () => setEditingAccount(null),
  });

  // 删除账号
  const deleteMutation = useCrudMutation({
    mutationFn: (id: number) => accountsApi.delete(id),
    successMessage: t('accounts.delete_success'),
    queryKey: queryKeys.accounts(),
    onSuccess: () => setDeletingAccount(null),
  });

  // 切换调度状态。这里做乐观更新，避免开关先跳回旧状态再等列表刷新。
  const toggleMutation = useMutation({
    mutationFn: (id: number) => accountsApi.toggleScheduling(id),
    onMutate: async (id) => {
      setPendingToggleIds((prev) => new Set(prev).add(id));
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts() });
      const previous = queryClient.getQueriesData<PagedData<AccountResp>>({ queryKey: queryKeys.accounts() });

      queryClient.setQueriesData<PagedData<AccountResp>>({ queryKey: queryKeys.accounts() }, (old) => {
        if (!old?.list) return old;
        return {
          ...old,
          list: old.list.map((account) => (
            account.id === id
              ? {
                  ...account,
                  state: (account.state === 'disabled' ? 'active' : 'disabled') as AccountResp['state'],
                  state_until: undefined,
                }
              : account
          )),
        };
      });

      return { previous };
    },
    onSuccess: (res, id) => {
      queryClient.setQueriesData<PagedData<AccountResp>>({ queryKey: queryKeys.accounts() }, (old) => {
        if (!old?.list) return old;
        return {
          ...old,
          list: old.list.map((account) => (
            account.id === id
              ? { ...account, state: res.state as AccountResp['state'], state_until: undefined }
              : account
          )),
        };
      });
    },
    onError: (err: Error, _id, context) => {
      context?.previous.forEach(([queryKey, value]) => {
        queryClient.setQueryData(queryKey, value);
      });
      toast('error', err.message);
    },
    onSettled: (_data, _error, id) => {
      setPendingToggleIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
    },
  });

  // 刷新令牌：后端在 refresh_token 已失效但能从 access_token JWT 解析到 plan_type
  // 时，会以 reauth_warning 形式回传降级提示；此时提示用户重新授权而不是弹 success。
  const refreshQuotaMutation = useMutation({
    mutationFn: (id: number) => accountsApi.refreshQuota(id),
    onSuccess: (res, id) => {
      applyQuotaRefreshResult(id, res);
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
      if (res?.reauth_warning) {
        toast('warning', t('accounts.refresh_quota_reauth_warning'));
      } else {
        toast('success', t('accounts.refresh_quota_success'));
      }
    },
    onError: (err: Error) => toast('error', err.message),
  });

  const clearRateLimitMarkersMutation = useMutation({
    mutationFn: (id: number) => accountsApi.clearFamilyCooldowns(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
      queryClient.invalidateQueries({ queryKey: queryKeys.accountUsage(platformFilter) });
      toast('success', t('accounts.clear_family_cooldowns_success'));
    },
    onError: (err: Error) => toast('error', err.message),
  });

  const toggleSchedulingMutateRef = useLatestRef(toggleMutation.mutate);
  const refreshQuotaMutateRef = useLatestRef(refreshQuotaMutation.mutate);
  const clearRateLimitMarkersMutateRef = useLatestRef(clearRateLimitMarkersMutation.mutate);
  const handleToggleScheduling = useCallback((id: number) => {
    if (pendingToggleIdsRef.current.has(id)) return;
    toggleSchedulingMutateRef.current(id);
  }, [toggleSchedulingMutateRef]);
  const handleEditAccount = useCallback((row: AccountResp) => {
    setEditingAccount(row);
  }, []);
  const handleDeleteAccount = useCallback((row: AccountResp) => {
    setDeletingAccount(row);
  }, []);
  const handleTestAccount = useCallback((row: AccountResp) => {
    setTestingAccount(row);
  }, []);
  const handleStatsAccount = useCallback((id: number) => {
    setStatsAccountId(id);
  }, []);
  const handleRefreshQuota = useCallback((id: number) => {
    refreshQuotaMutateRef.current(id);
  }, [refreshQuotaMutateRef]);
  const handleClearRateLimitMarkers = useCallback((id: number) => {
    clearRateLimitMarkersMutateRef.current(id);
  }, [clearRateLimitMarkersMutateRef]);

  // 批量操作通用的结果处理：全部成功 → success toast；部分成功 → warning；全部失败 → error。
  const handleBulkResult = (res: BulkOpResp, okKey: string) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
    const total = res.success + res.failed;
    if (res.failed === 0) {
      toast('success', t(okKey, { count: res.success }));
    } else if (res.success === 0) {
      toast('error', t('accounts.bulk_all_failed'));
    } else {
      toast('warning', t('accounts.bulk_partial', { success: res.success, failed: res.failed, total }));
    }
    clearSelection();
  };

  // 批量更新
  const bulkUpdateMutation = useMutation({
    mutationFn: (data: BulkUpdateAccountsReq) => accountsApi.bulkUpdate(data),
    onSuccess: (res) => {
      handleBulkResult(res, 'accounts.bulk_update_success');
      setShowBulkEditModal(false);
    },
    onError: (err: Error) => toast('error', err.message),
  });

  // 批量删除
  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.bulkDelete(ids),
    onSuccess: (res) => {
      handleBulkResult(res, 'accounts.bulk_delete_success');
      setShowBulkDeleteConfirm(false);
    },
    onError: (err: Error) => toast('error', err.message),
  });

  const bulkClearRateLimitMarkersMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.bulkClearFamilyCooldowns(ids),
    onSuccess: (res) => {
      handleBulkResult(res, 'accounts.bulk_clear_family_cooldowns_success');
      queryClient.invalidateQueries({ queryKey: queryKeys.accountUsage(platformFilter) });
    },
    onError: (err: Error) => toast('error', err.message),
  });

  const handleBulkEnable = () =>
    bulkUpdateMutation.mutate({ account_ids: selectedIds, state: 'active' });
  const handleBulkDisable = () =>
    bulkUpdateMutation.mutate({ account_ids: selectedIds, state: 'disabled' });

  // 批量刷新令牌：只有 OAuth 类型账号支持，预先过滤后开进度弹窗
  const handleBulkRefresh = () => {
    const selectedRows = (data?.list ?? []).filter((a) => selectedIds.includes(a.id));
    const oauthRows = selectedRows
      .filter((a) => a.type === 'oauth')
      .map((a) => ({ id: a.id, name: a.name }));
    if (oauthRows.length === 0) {
      toast('warning', t('accounts.bulk_refresh_no_oauth'));
      return;
    }
    if (oauthRows.length < selectedIds.length) {
      toast('info', t('accounts.bulk_refresh_filtered', {
        count: oauthRows.length,
        skipped: selectedIds.length - oauthRows.length,
      }));
    }
    setBulkRefreshTargets(oauthRows);
  };

  const accountActionLabels = useMemo(() => ({
    actions: t('common.actions'),
    clearCooldowns: t('accounts.clear_family_cooldowns'),
    delete: t('common.delete'),
    edit: t('common.edit'),
    more: t('common.more'),
    refreshQuota: t('accounts.refresh_quota'),
    stats: t('accounts.view_stats'),
    test: t('accounts.test_connection'),
  }), [t]);

  // 表格列定义
  const columns = useMemo<AccountTableColumn[]>(() => [
    {
      key: 'name',
      title: t('common.name'),
      width: '132px',
      mobileWidth: '112px',
      render: (row) => {
        const email = row.credentials?.email;
        return (
          <div className="flex w-full min-w-0 flex-col items-center text-center">
            <span style={{ color: 'var(--ag-text)' }} className="max-w-full truncate font-medium" title={row.name}>
              {row.name}
            </span>
            {email && (
              <span className="max-w-full truncate text-[11px]" style={{ color: 'var(--ag-text-tertiary)' }} title={email}>
                {email}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'platform',
      title: t('accounts.platform_type'),
      width: '96px',
      mobileWidth: '84px',
      render: (row) => {
        const PluginAccountIdentity = getPluginAccountIdentity(row.platform);
        return (
          <div className="flex w-full min-w-0 flex-col items-center gap-1 text-center">
            <span className="inline-flex max-w-full min-w-0 items-center justify-center gap-1">
              <PlatformIcon platform={row.platform} className="w-3.5 h-3.5" />
              <span className="min-w-0 truncate">{platformName(row.platform)}</span>
            </span>
            {PluginAccountIdentity ? (
              <PluginAccountIdentity
                accountId={row.id}
                accountType={row.type}
                context={{ account: row, credentials: row.credentials }}
              />
            ) : (
              <div className="flex max-w-full items-center justify-center gap-1">
                {row.type && (
                  <span className="truncate rounded px-1 py-0 text-[10px]" style={{ background: 'var(--ag-bg-surface)', border: '1px solid var(--ag-glass-border)', color: 'var(--ag-text-secondary)' }}>
                    {{ oauth: 'OAuth', session_key: 'Session Key', apikey: 'API Key' }[row.type] ?? row.type}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'groups',
      title: t('accounts.groups'),
      width: '92px',
      mobileWidth: '80px',
      align: 'center',
      render: (row) => {
        if (!row.group_ids || row.group_ids.length === 0) {
          return <span style={{ color: 'var(--ag-text-tertiary)' }}>-</span>;
        }
        const groupNames = row.group_ids.map((gid) => groupMap.get(gid) ?? `#${gid}`);
        const visibleGroups = groupNames.slice(0, 3);
        const hiddenCount = Math.max(0, groupNames.length - visibleGroups.length);
        return (
          <div className="flex max-h-full min-w-0 max-w-full flex-col items-center justify-center gap-0.5 overflow-hidden" title={groupNames.join('\n')}>
            {visibleGroups.map((name) => (
              <span
                key={name}
                className="max-w-full truncate rounded px-1.5 py-0 text-[10px] leading-none"
                style={{ background: 'var(--ag-bg-surface)', border: '1px solid var(--ag-glass-border)', color: 'var(--ag-text-secondary)' }}
              >
                {name}
              </span>
            ))}
            {hiddenCount > 0 ? (
              <span
                className="max-w-full truncate rounded px-1.5 py-0 text-[10px] font-semibold leading-none"
                style={{ background: 'var(--ag-bg-surface)', border: '1px solid var(--ag-glass-border)', color: 'var(--ag-text-secondary)' }}
              >
                +{hiddenCount}
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'capacity',
      title: t('accounts.capacity'),
      width: '84px',
      mobileWidth: '68px',
      align: 'center',
      render: (row) => {
        const current = row.current_concurrency || 0;
        const max = row.max_concurrency;
        return <AccountCapacityChip current={current} max={max} />;
      },
    },
    {
      key: 'status',
      title: t('common.status'),
      width: '84px',
      mobileWidth: '76px',
      align: 'center',
      render: (row) => <AccountStatusCell row={row} />,
    },
    {
      key: 'scheduling',
      title: t('accounts.scheduling'),
      width: '80px',
      mobileWidth: '72px',
      align: 'center',
      render: (row) => (
        <AccountSchedulingSwitch
          ariaLabel={t('accounts.scheduling')}
          isSelected={row.state !== 'disabled'}
          rowId={row.id}
          onToggle={handleToggleScheduling}
        />
      ),
    },
    {
      key: 'rate_multiplier',
      title: t('accounts.rate_multiplier'),
      width: '80px',
      mobileWidth: '72px',
      align: 'center',
      render: (row) => (
        <span className="font-mono" style={{ color: 'var(--ag-primary)' }}>
          {row.rate_multiplier}x
        </span>
      ),
    },
    // 用量窗口 —— 始终显示该列。历史上这里用 accounts.length > 0 作为
    // 显示门槛，但当插件尚未加载 / 上游 quota 接口都超时等边缘情况下，后端
    // 可能返回空 accounts map 导致整列消失。那样用户连点"刷新用量"的入口都
    // 没有。正确做法是：列始终在，每一行的 cell 自己处理 usage 缺失显示 "-"。
    ...[{
      key: 'usage_window',
      title: t('accounts.usage_window'),
      width: '364px',
      mobileWidth: '364px',
      maxWidth: '364px',
      align: 'center' as const,
      render: (row: AccountResp) => {
        const usage = usageDataRef.current?.accounts?.[String(row.id)];

        // 整个区域可点击刷新
        const handleRefreshClick = async (e: React.MouseEvent) => {
          e.stopPropagation();
          const target = e.currentTarget as HTMLElement;
          target.style.opacity = '0.5';
          target.style.pointerEvents = 'none';
          try {
            const result = await accountsApi.refreshQuota(row.id);
            applyQuotaRefreshResult(row.id, result);
            queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
            queryClient.invalidateQueries({ queryKey: queryKeys.accountUsage(platformFilter) });
            toast('success', t('accounts.refresh_usage_success', '用量刷新成功'));
          } catch (err) {
            // 展开后端返回的具体原因（如"账号凭证已失效，请重新授权"）；
            // 没有 message 时才回退到通用文案。
            const message = err instanceof Error && err.message ? err.message : t('accounts.refresh_usage_failed', '用量刷新失败');
            toast('error', message);
          }
          target.style.opacity = '1';
          target.style.pointerEvents = '';
        };

        if (!usage) {
          // 非活跃账号（backend 没 seed 占位）或平台不支持：显示占位 + 刷新
          return (
            <div
              className="flex items-center gap-1 cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-[var(--ag-glass-border)]"
              title={t('accounts.refresh_usage', '点击刷新用量')}
              onClick={handleRefreshClick}
            >
              <span style={{ color: 'var(--ag-text-tertiary)' }}>-</span>
              <RefreshCw size={11} style={{ color: 'var(--ag-text-tertiary)' }} />
            </div>
          );
        }

        type UsageWindowRow = { id: string; window?: AccountUsageWindow };
        const windows: AccountUsageWindow[] = usage.windows || [];
        const credits: AccountUsageCredits | null = usage.credits || null;
        const todayStats: AccountUsageTodayStats | null = usage.today_stats || null;

        // 紧凑数字格式化（和 sub2api 对齐：K / M / B 后缀）
        const formatCompact = (num: number, allowBillions = true) => {
          if (!num) return '0';
          const abs = Math.abs(num);
          if (allowBillions && abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
          if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
          if (abs >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
          return String(num);
        };

        const hasTodayStats = todayStats != null;
        const canRefresh = row.type !== 'apikey';
        if (windows.length === 0 && !credits && !hasTodayStats) {
          return (
            <div
              className={
                canRefresh
                  ? 'flex items-center gap-1 cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-[var(--ag-glass-border)]'
                  : 'flex items-center gap-1 rounded px-1 py-0.5'
              }
              title={canRefresh ? t('accounts.refresh_usage', '点击刷新用量') : undefined}
              onClick={canRefresh ? handleRefreshClick : undefined}
            >
              <span style={{ color: 'var(--ag-text-tertiary)' }}>-</span>
              {canRefresh && <RefreshCw size={11} style={{ color: 'var(--ag-text-tertiary)' }} />}
            </div>
          );
        }

        const getResetSeconds = (w: AccountUsageWindow) => {
          if (typeof w.reset_seconds === 'number') return w.reset_seconds;
          if (typeof w.reset_after_seconds === 'number') return w.reset_after_seconds;
          if (w.reset_at) {
            const delta = Date.parse(w.reset_at) - Date.now();
            if (Number.isFinite(delta) && delta > 0) return Math.floor(delta / 1000);
          }
          return 0;
        };

        const formatReset = (seconds: number) => {
          if (!seconds || seconds <= 0) return '-';
          const d = Math.floor(seconds / 86400);
          const h = Math.floor((seconds % 86400) / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
          if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
          return `${m}m`;
        };

        const usageColor = (pct: number) => {
          if (pct < 50) return 'var(--ag-success)';
          if (pct < 80) return 'var(--ag-warning)';
          return 'var(--ag-danger)';
        };

        // 简化 label：取最后一段（如 "GPT-5.3-Codex-Spark" → "Spark"）
        const shortLabel = (label: string) => {
          const parts = label.split(/[\s]+/);
          // 第一部分是时间窗口（如 "5h"、"7d"），后面是模型名
          const timePart = parts[0];
          if (parts.length <= 1) return timePart;
          const modelPart = parts.slice(1).join(' ');
          const segments = modelPart.split('-');
          return `${timePart} ${segments[segments.length - 1]}`;
        };
        const getWindowSlot = (w: AccountUsageWindow) => {
          const key = w.key || '';
          const label = w.label || '';
          const slot = key.includes(':7d') || key === '7d' || label.startsWith('7d') ? '7d' : '5h';
          const group = key.startsWith('model:')
            ? key.replace(/^model:(5h|7d):/, 'model:')
            : 'base';
          return { group, slot };
        };
        const buildWindowRows = (items: AccountUsageWindow[]): UsageWindowRow[] => {
          const groups: Array<{ id: string; five?: AccountUsageWindow; seven?: AccountUsageWindow }> = [];
          const groupMap = new Map<string, { id: string; five?: AccountUsageWindow; seven?: AccountUsageWindow }>();

          for (const item of items) {
            const { group, slot } = getWindowSlot(item);
            let bucket = groupMap.get(group);
            if (!bucket) {
              bucket = { id: group };
              groupMap.set(group, bucket);
              groups.push(bucket);
            }
            if (slot === '7d') bucket.seven = item;
            else bucket.five = item;
          }

          return groups.flatMap((group) => {
            const rows: UsageWindowRow[] = [];
            if (group.five) {
              rows.push({ id: `${group.id}:5h`, window: group.five });
            } else if (group.seven) {
              rows.push({ id: `${group.id}:5h-placeholder` });
            }
            if (group.seven) {
              rows.push({ id: `${group.id}:7d`, window: group.seven });
            }
            return rows;
          });
        };
        const windowRows = buildWindowRows(windows);

        const badgeStyle = { background: 'var(--ag-bg-surface)', border: '1px solid var(--ag-glass-border)' };
        const todayImageCount = row.platform === 'openai' ? (row.today_image_count ?? 0) : 0;
        const showImageCount = row.platform === 'openai';
        const accessRequestsText = formatCompact(todayStats?.requests ?? 0, false);
        const accessImageText = formatCompact(todayImageCount, false);
        const accessText = showImageCount ? `${accessRequestsText}/${accessImageText}` : accessRequestsText;
        const hideAccessLabel = showImageCount && accessText.length > '100/100'.length;
        const accessLabel = showImageCount
          ? (
            <span className="inline-flex min-w-0 items-center">
              <span className="truncate">{t('accounts.today_access_count', '访问')}</span>
              <span aria-hidden="true" className="px-px text-text">/</span>
              <span>{t('accounts.image_count_inline_label', '图').trim()}</span>
            </span>
          )
          : t('accounts.today_access_count', '访问');
        const accessValue = showImageCount
          ? (
            <span className="inline-flex min-w-0 items-center justify-end">
              <span>{accessRequestsText}</span>
              <span aria-hidden="true" className="px-px text-text">/</span>
              <span className="text-text">{accessImageText}</span>
            </span>
          )
          : accessText;
        const todayMetricClass = 'ag-account-usage-metric';
        const todayMetricStyle = (color: string, foreground = color) => ({
          background: `color-mix(in srgb, ${color} 10%, transparent)`,
          borderColor: `color-mix(in srgb, ${color} 22%, var(--ag-border))`,
          color: foreground,
        });
        const todayMetricColumnClass = 'ag-account-usage-metrics';
        const todayMetricChips = hasTodayStats && todayStats ? (
          <div
            className={todayMetricColumnClass}
            title={t('accounts.today_stats_tooltip', '今日账号消耗（本地时区自然日）')}
          >
            <span
              className={todayMetricClass}
              style={todayMetricStyle('var(--ag-info)')}
              title={showImageCount ? t('accounts.image_count_tooltip', '今日生图请求数（gpt-image 系列）') : undefined}
            >
              {hideAccessLabel ? null : (
                <span className="ag-account-usage-metric-label text-text-secondary">{accessLabel}</span>
              )}
              <span className={`ag-account-usage-metric-value ${hideAccessLabel ? 'ag-account-usage-metric-value--solo' : ''}`}>{accessValue}</span>
            </span>
            <span className={todayMetricClass} style={todayMetricStyle('var(--ag-primary)')}>
              <span className="ag-account-usage-metric-label text-text-secondary">Token</span>
              <span className="ag-account-usage-metric-value">{formatCompact(todayStats.tokens)}</span>
            </span>
            <span
              className={todayMetricClass}
              style={todayMetricStyle('var(--ag-warning)')}
              title={t('accounts.window_user_cost', '用户消耗（平台计费）')}
            >
              <span className="ag-account-usage-metric-label text-text-secondary">{t('accounts.user_cost_short', '消费')}</span>
              <span className="ag-account-usage-metric-value">
                <span style={{ color: 'var(--ag-warning)' }}>$</span>
                <span className="text-text">{todayStats.user_cost.toFixed(2)}</span>
              </span>
            </span>
            <span
              className={todayMetricClass}
              style={todayMetricStyle('var(--ag-success)', 'var(--ag-success-foreground)')}
              title={t('accounts.window_account_cost', '账号成本（上游计费）')}
            >
              <span className="ag-account-usage-metric-label text-text-secondary">{t('accounts.account_cost_short', '成本')}</span>
              <span className="ag-account-usage-metric-value">
                <span style={{ color: 'var(--ag-success)' }}>$</span>
                <span className="text-text">{todayStats.account_cost.toFixed(2)}</span>
              </span>
            </span>
          </div>
        ) : null;

        return (
          <div
            className={
              canRefresh
                ? 'ag-account-usage-cell ag-account-usage-cell--refreshable'
                : 'ag-account-usage-cell'
            }
            style={{ fontFamily: 'var(--ag-font-mono)' }}
            title={canRefresh ? t('accounts.refresh_usage', '点击刷新用量') : undefined}
            onClick={canRefresh ? handleRefreshClick : undefined}
          >
            <div className={todayMetricChips ? 'ag-account-usage-layout' : 'ag-account-usage-layout ag-account-usage-layout--centered'}>
              <div className="ag-account-usage-windows">
                {(() => {
                  const PluginUsageWindow = getPluginUsageWindow(row.platform);
                  if (PluginUsageWindow && windows.length > 0) {
                    return (
                      <PluginUsageWindow
                        accountId={row.id}
                        accountType={row.type}
                        context={{ windows }}
                      />
                    );
                  }
                  return windowRows.map((item) => {
                    const w = item.window;
                    if (!w) {
                      return <div key={item.id} className="h-5" aria-hidden="true" />;
                    }
                    const percent = Math.round(w.used_percent);
                    const barPercent = Math.max(0, Math.min(100, percent));
                    const color = usageColor(w.used_percent);
                    const resetText = formatReset(getResetSeconds(w));
                    return (
                      <div key={item.id} className="ag-account-usage-window-row">
                        <span className="ag-account-usage-window-label text-text-secondary" style={badgeStyle} title={w.label}>
                          {shortLabel(w.label)}
                        </span>
                        <div className="ag-account-usage-bar" style={{ background: 'var(--ag-glass-border)' }}>
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${barPercent}%`, background: color }}
                          />
                        </div>
                        <span className="ag-account-usage-percent" style={{ color }}>
                          {percent}%
                        </span>
                        <span className="ag-account-usage-reset" title={resetText}>
                          {resetText}
                        </span>
                      </div>
                    );
                  });
                })()}
                {credits && (
                  <div className="flex h-5 items-center gap-1">
                    <span className="inline-flex items-center justify-center px-1 py-0 rounded text-[10px] font-medium" style={badgeStyle}>
                      $
                    </span>
                    <span style={{ color: credits.unlimited ? 'var(--ag-success)' : credits.balance > 0 ? 'var(--ag-text)' : 'var(--ag-danger)' }}>
                      {credits.unlimited ? '∞' : `$${Number(credits.balance).toFixed(2)}`}
                    </span>
                  </div>
                )}
              </div>
              {todayMetricChips && (
                <>
                  <span aria-hidden="true" />
                  {todayMetricChips}
                </>
              )}
            </div>
          </div>
        );
      },
    }],
    {
      key: 'last_used_at',
      title: t('accounts.last_used'),
      width: '120px',
      mobileWidth: '88px',
      align: 'center',
      render: (row) => {
        if (!row.last_used_at) {
          return <span style={{ color: 'var(--ag-text-tertiary)' }}>-</span>;
        }
        const diff = Date.now() - new Date(row.last_used_at).getTime();
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        let relative: string;
        if (seconds < 60) relative = t('accounts.just_now');
        else if (minutes < 60) relative = t('accounts.minutes_ago', { n: minutes });
        else if (hours < 24) relative = t('accounts.hours_ago', { n: hours });
        else relative = t('accounts.days_ago', { n: days });
        return (
          <span className="text-xs" style={{ color: 'var(--ag-text-secondary)' }} title={new Date(row.last_used_at).toLocaleString()}>
            {relative}
          </span>
        );
      },
    },
    {
      key: 'actions',
      title: t('common.actions'),
      width: '116px',
      mobileWidth: '96px',
      align: 'center',
      render: (row) => (
        <AccountRowActions
          row={row}
          labels={accountActionLabels}
          onEdit={handleEditAccount}
          onDelete={handleDeleteAccount}
          onTest={handleTestAccount}
          onStats={handleStatsAccount}
          onRefreshQuota={handleRefreshQuota}
          onClearCooldowns={handleClearRateLimitMarkers}
        />
      ),
    },
  ], [
    accountActionLabels,
    applyQuotaRefreshResult,
    groupMap,
    handleClearRateLimitMarkers,
    handleDeleteAccount,
    handleEditAccount,
    handleRefreshQuota,
    handleStatsAccount,
    handleTestAccount,
    handleToggleScheduling,
    platformFilter,
    platformName,
    platformsKey,
    queryClient,
    t,
    toast,
    usageData?.accounts,
  ]);
  const rows = data?.list ?? [];
  const total = data?.total ?? 0;
  const totalPages = getTotalPages(total, pageSize);
  const visibleRowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectedVisibleCount = useMemo(
    () => selectionStore.countVisible(visibleRowIds),
    [selectionStore, selectionVersion, visibleRowIds],
  );
  const allVisibleSelected = visibleRowIds.length > 0 && selectedVisibleCount === visibleRowIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectAllAriaLabel = t('common.select_all', 'Select all');
  const selectRowAriaLabel = t('common.select', 'Select');
  const setVisibleRowsSelected = useCallback((isSelected: boolean) => {
    runAfterInputFrame(() => selectionStore.setRows(visibleRowIds, isSelected));
  }, [selectionStore, visibleRowIds]);
  const setRowSelected = useCallback((id: number, isSelected: boolean) => {
    runAfterInputFrame(() => selectionStore.setRow(id, isSelected));
  }, [selectionStore]);
  const typeOptions = useMemo<AccountTypeFilterOption[]>(() => [
    { id: '', label: t('accounts.all_types', '全部类型') },
    { id: 'oauth', label: 'OAuth' },
    { id: 'apikey', label: 'API Key' },
  ], [t]);
  const oauthPlanOptions = useMemo<AccountTypeFilterOption[]>(() => oauthPlanFilters
    .filter((item) => !platformFilter || item.platform === platformFilter)
    .map((item) => ({
      id: item.id,
      label: platformFilter ? `OAuth ${item.planLabel}` : `${item.platformLabel} OAuth ${item.planLabel}`,
      platformLabel: platformFilter ? undefined : item.platformLabel,
      planLabel: item.planLabel,
    })), [oauthPlanFilters, platformFilter]);
  const groupOptions = useMemo(() => [
    { id: '', label: t('accounts.all_groups') },
    { id: UNGROUPED_GROUP_FILTER, label: t('accounts.ungrouped') },
    ...(allGroupsData?.list ?? []).map((g) => ({ id: String(g.id), label: g.name })),
  ], [allGroupsData?.list, t]);
  const proxyOptions = useMemo(() => [
    { id: '', label: t('accounts.all_proxies') },
    ...(allProxiesData?.list ?? []).map((p) => ({ id: String(p.id), label: p.name })),
  ], [allProxiesData?.list, t]);
  const selectedPlatformLabel = PLATFORM_OPTIONS.find((item) => item.id === platformFilter)?.label ?? t('accounts.all_platforms');
  const selectedStateLabel = STATE_OPTIONS.find((item) => item.id === stateFilter)?.label ?? t('users.all_status');
  const selectedTypeOption = typeOptions.find((item) => item.id === typeFilter)
    ?? oauthPlanOptions.find((item) => item.id === typeFilter);
  const selectedTypeLabel = selectedTypeOption?.label ?? t('accounts.all_types', '全部类型');
  const selectedTypeNode = selectedTypeOption ? renderAccountTypeFilterOption(selectedTypeOption) : selectedTypeLabel;
  const selectedGroupLabel = groupOptions.find((item) => item.id === groupFilter)?.label ?? t('accounts.all_groups');
  const selectedProxyLabel = proxyOptions.find((item) => item.id === proxyFilter)?.label ?? t('accounts.all_proxies');
  useEffect(() => {
    if (!typeFilter) return;
    if (typeOptions.some((item) => item.id === typeFilter)) return;
    if (oauthPlanOptions.some((item) => item.id === typeFilter)) return;
    if (typeFilter.startsWith('oauth_plan:') && platformsLoading) return;
    setTypeFilter(typeFilter.startsWith('oauth_plan:') ? 'oauth' : '');
    setPage(1);
  }, [oauthPlanOptions, platformsLoading, setPage, typeFilter, typeOptions]);
  const toolbarFilters = [
    {
      key: 'platform',
      label: t('groups.platform'),
      value: platformFilter,
      selectedLabel: selectedPlatformLabel,
      options: PLATFORM_OPTIONS,
      setValue: setPlatformFilter,
      widthClass: 'w-full sm:w-48',
    },
    {
      key: 'state',
      label: t('common.status'),
      value: stateFilter,
      selectedLabel: selectedStateLabel,
      options: STATE_OPTIONS,
      setValue: setStateFilter,
      widthClass: 'w-full sm:w-48',
    },
    {
      key: 'type',
      label: t('common.type'),
      value: typeFilter,
      selectedLabel: selectedTypeNode,
      options: typeOptions,
      setValue: setTypeFilter,
      widthClass: 'w-full sm:w-48',
    },
    {
      key: 'group',
      label: t('accounts.group'),
      value: groupFilter,
      selectedLabel: selectedGroupLabel,
      options: groupOptions,
      setValue: setGroupFilter,
      widthClass: 'w-full sm:w-48',
    },
    {
      key: 'proxy',
      label: t('accounts.proxy'),
      value: proxyFilter,
      selectedLabel: selectedProxyLabel,
      options: proxyOptions,
      setValue: setProxyFilter,
      widthClass: 'w-full sm:w-48',
    },
  ];
  const selectTypeFilter = useCallback((nextValue: string) => {
    setTypeFilter(nextValue);
    setPage(1);
    closeTypeFilterMenu();
  }, [closeTypeFilterMenu, setPage]);
  const renderTypeFilterMenu = () => (
    <div ref={typeFilterMenuRef} className="select select--full-width ag-account-type-select">
      <button
        type="button"
        aria-label={t('common.type')}
        aria-haspopup="menu"
        aria-expanded={isTypeMenuOpen}
        className="select__trigger select__trigger--full-width ag-account-type-trigger"
        onClick={() => {
          setIsTypeMenuOpen((open) => {
            if (open) setIsOAuthPlanMenuOpen(false);
            return !open;
          });
        }}
      >
        <span className="select__value ag-account-type-trigger-value">{selectedTypeNode}</span>
        <ChevronDown
          className="select__indicator ag-account-type-trigger-indicator"
          data-open={isTypeMenuOpen ? 'true' : undefined}
        />
      </button>
      {isTypeMenuOpen ? (
        <div className="select__popover ag-account-type-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="ag-account-type-menu-item"
            onPointerEnter={() => setIsOAuthPlanMenuOpen(false)}
            onFocus={() => setIsOAuthPlanMenuOpen(false)}
            onClick={() => selectTypeFilter('')}
          >
            {typeOptions[0]?.label ?? t('accounts.all_types', '全部类型')}
          </button>
          <div
            className="ag-account-type-cascade-row"
            onPointerEnter={() => setIsOAuthPlanMenuOpen(true)}
            onPointerLeave={() => setIsOAuthPlanMenuOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              className="ag-account-type-menu-item"
              onFocus={() => setIsOAuthPlanMenuOpen(true)}
              onClick={() => selectTypeFilter('oauth')}
            >
              <span className="truncate">OAuth</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            </button>
            {isOAuthPlanMenuOpen ? (
              <>
                <span aria-hidden="true" className="ag-account-type-submenu-bridge" />
                <div className="ag-account-type-submenu" role="menu">
                  {oauthPlanOptions.length > 0 ? (
                    oauthPlanOptions.map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        role="menuitem"
                        className="ag-account-type-submenu-item"
                        onClick={() => selectTypeFilter(plan.id)}
                      >
                        {renderAccountTypeFilterOption(plan, false)}
                      </button>
                    ))
                  ) : platformsLoading ? (
                    <span className="ag-account-type-submenu-loading">{t('common.loading')}</span>
                  ) : (
                    <span className="ag-account-type-submenu-loading">{t('accounts.no_oauth_plans', '暂无套餐')}</span>
                  )}
                </div>
              </>
            ) : null}
          </div>
          <button
            type="button"
            role="menuitem"
            className="ag-account-type-menu-item"
            onPointerEnter={() => setIsOAuthPlanMenuOpen(false)}
            onFocus={() => setIsOAuthPlanMenuOpen(false)}
            onClick={() => selectTypeFilter('apikey')}
          >
            API Key
          </button>
        </div>
      ) : null}
    </div>
  );
  return (
    <div>
      <div className="mb-5 flex min-h-12 flex-col gap-3 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex min-h-12 flex-col flex-wrap items-stretch gap-3 sm:flex-row sm:items-center">
            <div className="w-full sm:w-48">
              <HeroTextField fullWidth>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
                  <Input
                    className="pl-9"
                    value={keyword}
                    onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
                    placeholder={t('accounts.search_placeholder', '搜索账号名称...')}
                  />
                </div>
              </HeroTextField>
            </div>

            {toolbarFilters.map((filter) => (
              <div
                key={filter.key}
                className={filter.widthClass}
              >
                {filter.key === 'type' ? renderTypeFilterMenu() : (
                  <Select
                    aria-label={filter.label}
                    fullWidth
                    selectedKey={filter.value}
                    onSelectionChange={(key) => {
                      const nextValue = key == null ? '' : String(key);
                      filter.setValue(nextValue);
                      setPage(1);
                    }}
                  >
                    <Label className="sr-only">{filter.label}</Label>
                    <Select.Trigger>
                      <Select.Value>{filter.selectedLabel}</Select.Value>
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox items={filter.options}>
                        {(item) => (
                          <ListBox.Item
                            id={item.id}
                            textValue={item.label}
                          >
                            {item.label}
                          </ListBox.Item>
                        )}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-start gap-2 xl:ml-auto xl:justify-end">
          <Button
            isIconOnly
            aria-label={t('common.refresh')}
            size="sm"
            variant="ghost"
            className="h-8 w-8 min-w-8"
            onPress={refreshAccounts}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Dropdown>
            <Dropdown.Trigger
              className={`ag-account-auto-refresh-trigger button button--sm ${autoRefresh ? 'button--secondary' : 'button--ghost'} h-8 min-w-[7.5rem] whitespace-nowrap px-3`}
            >
              <AutoRefreshCountdownLabel
                autoRefresh={autoRefresh}
                label={autoRefreshLabel}
                offLabel={autoRefreshOffLabel}
                onRefresh={refreshAccounts}
              />
              <ChevronDown className="h-3 w-3 shrink-0" />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={t('accounts.auto_refresh')}
                selectedKeys={new Set([`auto_${autoRefresh}`])}
                selectionMode="single"
                onAction={(key) => {
                  const action = String(key);
                  setAutoRefresh(Number(action.replace('auto_', '')));
                }}
              >
                {AUTO_REFRESH_OPTIONS.map((sec) => (
                  <Dropdown.Item key={sec} id={`auto_${sec}`} textValue={sec === 0 ? t('accounts.auto_refresh_off') : `${t('accounts.auto_refresh')}${sec}s`}>
                    <span className="flex items-center justify-between gap-6">
                      <span>{sec === 0 ? t('accounts.auto_refresh_off') : `${t('accounts.auto_refresh')}${sec}s`}</span>
                      {autoRefresh === sec ? <span className="text-primary">✓</span> : null}
                    </span>
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Button
            variant="secondary"
            onPress={() => importInputRef.current?.click()}
            isDisabled={importMutation.isPending}
            aria-busy={importMutation.isPending}
          >
            <Upload className="h-4 w-4" />
            {t('accounts.import')}
          </Button>
          <Button
            variant="secondary"
            onPress={() => exportMutation.mutate()}
            isDisabled={exportMutation.isPending}
            aria-busy={exportMutation.isPending}
          >
            <Download className="h-4 w-4" />
            {t('accounts.export')}
          </Button>
          <Button variant="primary" onPress={() => setShowCreateModal(true)}>
            <Plus className="h-4 w-4" />
            {t('accounts.create')}
          </Button>
        </div>
      </div>
      {/* 隐藏的文件选择器（供导入按钮触发） */}
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFile}
      />

      {/* 表格 */}
      <div className="ag-resource-table ag-accounts-table">
        <div className="ag-resource-table-scroll" data-slot="wrapper">
          {selectedCount > 0 ? (
            <div onClick={(event) => event.stopPropagation()}>
              <BulkActionsBar
                overlay
                selectedCount={selectedCount}
                onClear={clearSelection}
                onEdit={() => setShowBulkEditModal(true)}
                onEnable={handleBulkEnable}
                onDisable={handleBulkDisable}
                onRefreshQuota={handleBulkRefresh}
                onClearRateLimitMarkers={() => bulkClearRateLimitMarkersMutation.mutate(selectedIds)}
                onDelete={() => setShowBulkDeleteConfirm(true)}
              />
            </div>
          ) : null}
          <table
            aria-label={t('accounts.title', 'Accounts')}
            className="ag-resource-table-content ag-accounts-table-content"
            data-slot="table"
            style={{ minWidth: 'var(--ag-accounts-current-table-width)' }}
          >
            <thead data-slot="thead">
              <tr data-slot="tr">
                <th data-slot="th" scope="col" className="text-center" style={ACCOUNT_SELECTION_COLUMN_STYLE}>
                  <div className="inline-flex" onClick={(event) => event.stopPropagation()}>
                    <TableSelectionCheckbox
                      ariaLabel={selectAllAriaLabel}
                      isIndeterminate={someVisibleSelected}
                      isSelected={allVisibleSelected}
                      onChange={setVisibleRowsSelected}
                    />
                  </div>
                </th>
                {columns.map((column) => (
                  <th
                    data-slot="th"
                    id={column.key}
                    key={column.key}
                    scope="col"
                    className={columnAlignClass(column.align)}
                    style={columnWidthStyle(column)}
                  >
                    {column.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody data-slot="tbody">
              {isLoading ? (
                <AccountsTableLoadingRow colSpan={columns.length + 1} />
              ) : rows.length === 0 ? (
                <tr data-slot="tr" data-key="empty">
                  <td data-slot="td" colSpan={columns.length + 1}>
                    <EmptyState>
                      <div className="text-sm text-default-500">{t('common.no_data')}</div>
                    </EmptyState>
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <AccountTableRow
                    key={row.id}
                    columns={columns}
                    row={row}
                    selectRowAriaLabel={selectRowAriaLabel}
                    selectionStore={selectionStore}
                    onSelectedChange={setRowSelected}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <TablePaginationFooter
          page={page}
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          setPage={setPage}
          setPageSize={setPageSize}
          total={total}
          totalPages={totalPages}
        />
      </div>

      {/* 创建弹窗 */}
      <CreateAccountModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={(data) => createMutation.mutate(data)}
        onBatchImport={async (accounts) => {
          const res = await accountsApi.import(accounts);
          queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
          queryClient.invalidateQueries({ queryKey: queryKeys.accountUsage(platformFilter) });
          if (res.failed > 0) {
            toast('warning', t('accounts.import_partial', { imported: res.imported, failed: res.failed }));
          } else {
            toast('success', t('accounts.import_success', { count: res.imported }));
          }
          setShowCreateModal(false);
          return { imported: res.imported, failed: res.failed };
        }}
        loading={createMutation.isPending}
        platforms={platforms}
      />

      {/* 编辑弹窗 */}
      {editingAccount && (
        <EditAccountModal
          open
          account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSubmit={(data) =>
            updateMutation.mutate({ id: editingAccount.id, data })
          }
          loading={updateMutation.isPending}
        />
      )}

      {/* 删除确认 */}
      <AlertDialog
        isOpen={!!deletingAccount}
        onOpenChange={(open) => {
          if (!open) setDeletingAccount(null);
        }}
      >
        <AlertDialog.Backdrop>
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog className="ag-elevation-modal">
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{t('accounts.delete_title')}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>{t('accounts.delete_confirm', { name: deletingAccount?.name })}</AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="secondary" onPress={() => setDeletingAccount(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  aria-busy={deleteMutation.isPending}
                  isDisabled={deleteMutation.isPending}
                  variant="danger"
                  onPress={() => deletingAccount && deleteMutation.mutate(deletingAccount.id)}
                >
                  {deleteMutation.isPending ? <Spinner size="sm" /> : null}
                  {t('common.confirm')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>

      {/* 批量编辑弹窗 */}
      <BulkEditAccountModal
        open={showBulkEditModal}
        count={selectedIds.length}
        onClose={() => setShowBulkEditModal(false)}
        onSubmit={(patch) =>
          bulkUpdateMutation.mutate({ account_ids: selectedIds, ...patch })
        }
        loading={bulkUpdateMutation.isPending}
      />

      {/* 批量删除确认 */}
      <AlertDialog isOpen={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog className="ag-elevation-modal">
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{t('accounts.bulk_delete_title')}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>{t('accounts.bulk_delete_confirm', { count: selectedIds.length })}</AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="secondary" onPress={() => setShowBulkDeleteConfirm(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  aria-busy={bulkDeleteMutation.isPending}
                  isDisabled={bulkDeleteMutation.isPending}
                  variant="danger"
                  onPress={() => bulkDeleteMutation.mutate(selectedIds)}
                >
                  {bulkDeleteMutation.isPending ? <Spinner size="sm" /> : null}
                  {t('common.confirm')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>

      {/* 批量刷新令牌进度弹窗 */}
      {bulkRefreshTargets && (
        <BulkRefreshProgressModal
          open
          accounts={bulkRefreshTargets}
          onClose={() => setBulkRefreshTargets(null)}
          onFinished={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
            clearSelection();
          }}
        />
      )}

      {/* 测试连接 */}
      <AccountTestModal
        open={!!testingAccount}
        account={testingAccount}
        onClose={() => setTestingAccount(null)}
      />

      {/* 账号统计 */}
      {statsAccountId !== null && (
        <AccountStatsModal
          accountId={statsAccountId}
          // 累计生图数从列表行直接传：BatchImageStats 一次查到，避免再让 stats endpoint 多跑一次。
          // 仅 OpenAI 平台账号有该字段；非 openai 时 modal 内部会跳过显示。
          lifetimeImageCount={data?.list.find((a) => a.id === statsAccountId)?.total_image_count}
          onClose={() => setStatsAccountId(null)}
        />
      )}
    </div>
  );
}
