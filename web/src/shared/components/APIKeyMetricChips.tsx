import { Chip } from '@heroui/react';

type APIKeyMetricChipColor = 'default' | 'warning' | 'success' | 'accent';

export type APIKeyMetricChipItem = {
  amount?: number;
  color: APIKeyMetricChipColor;
  dollarTone?: APIKeyMetricChipColor;
  highlightDollar?: boolean;
  label: string;
  mutedWhenZero?: boolean;
  value?: string;
};

function formatMoneyAmount(value: number) {
  return (Number.isFinite(value) ? value : 0).toFixed(4);
}

function formatMetricTitleValue(item: APIKeyMetricChipItem) {
  if (item.amount != null) return `$${formatMoneyAmount(item.amount)}`;
  return item.value ?? '';
}

function APIKeyMetricChip({ amount, color, dollarTone, highlightDollar, label, mutedWhenZero, value }: APIKeyMetricChipItem) {
  const amountText = amount == null ? null : formatMoneyAmount(amount);
  const isMutedZero = mutedWhenZero && amount === 0;
  const chipClassName = [
    'ag-api-key-metric-chip',
    isMutedZero ? 'ag-api-key-metric-chip--zero' : '',
  ].filter(Boolean).join(' ');
  const effectiveDollarTone = dollarTone ?? (highlightDollar ? 'warning' : undefined);
  const dollarClassName = [
    'ag-api-key-metric-dollar',
    effectiveDollarTone ? `ag-api-key-metric-dollar--${effectiveDollarTone}` : '',
  ].filter(Boolean).join(' ');

  return (
    <Chip className={chipClassName} color={isMutedZero ? 'default' : color} size="sm" variant="soft">
      <span className="ag-api-key-metric-chip-label">{label}</span>
      <span className="ag-api-key-metric-chip-value">
        {amountText == null ? (
          value === '∞' ? <span className="ag-api-key-metric-infinity">{value}</span> : value
        ) : (
          <>
            <span className={dollarClassName}>$</span>
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
