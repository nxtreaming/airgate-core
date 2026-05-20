import { Chip } from '@heroui/react';

type APIKeyMetricChipColor = 'default' | 'warning' | 'success' | 'accent';

export type APIKeyMetricChipItem = {
  amount?: number;
  color: APIKeyMetricChipColor;
  highlightDollar?: boolean;
  label: string;
  value?: string;
};

function formatMoneyAmount(value: number) {
  return (Number.isFinite(value) ? value : 0).toFixed(4);
}

function formatMetricTitleValue(item: APIKeyMetricChipItem) {
  if (item.amount != null) return `$${formatMoneyAmount(item.amount)}`;
  return item.value ?? '';
}

function APIKeyMetricChip({ amount, color, highlightDollar, label, value }: APIKeyMetricChipItem) {
  const amountText = amount == null ? null : formatMoneyAmount(amount);

  return (
    <Chip className="ag-api-key-metric-chip" color={color} size="sm" variant="soft">
      <span className="ag-api-key-metric-chip-label">{label}</span>
      <span className="ag-api-key-metric-chip-value">
        {amountText == null ? (
          value === '∞' ? <span className="ag-api-key-metric-infinity">{value}</span> : value
        ) : (
          <>
            <span className={highlightDollar ? 'ag-api-key-metric-dollar ag-api-key-metric-dollar--warning' : 'ag-api-key-metric-dollar'}>$</span>
            <span>{amountText}</span>
          </>
        )}
      </span>
    </Chip>
  );
}

export function APIKeyMetricChips({
  className,
  items,
}: {
  className?: string;
  items: APIKeyMetricChipItem[];
}) {
  const title = items
    .map((item) => `${item.label} ${formatMetricTitleValue(item)}`)
    .join(' / ');

  return (
    <div className={`ag-api-key-metric-chips ${className ?? ''}`} title={title}>
      {items.map((item) => (
        <APIKeyMetricChip key={item.label} {...item} />
      ))}
    </div>
  );
}
