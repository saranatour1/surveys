import * as React from 'react';
import * as RechartsPrimitive from 'recharts';
import { cn } from '@/lib/utils';

type ChartConfigItem = {
  label?: React.ReactNode;
  color?: string;
};

export type ChartConfig = Record<string, ChartConfigItem>;

type ChartContextValue = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
}) {
  const uniqueId = React.useId().replace(/:/g, '');
  const chartId = `chart-${id ?? uniqueId}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          '[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke=\"#ccc\"]]:stroke-border/50 [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke=\"#ccc\"]]:stroke-border/50 flex aspect-video justify-center text-xs',
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorRules = Object.entries(config)
    .map(([key, value]) => {
      if (!value.color) {
        return '';
      }
      return `[data-chart=${id}] { --color-${key}: ${value.color}; }`;
    })
    .join('\n');

  if (!colorRules) {
    return null;
  }

  return <style dangerouslySetInnerHTML={{ __html: colorRules }} />;
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipPayloadItem = {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  fill?: string;
  payload?: { label?: string };
};

function ChartTooltipContent({
  active,
  payload,
  hideLabel = false,
  labelFormatter,
  formatter,
  className,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  hideLabel?: boolean;
  labelFormatter?: (value: string, payload: TooltipPayloadItem[]) => React.ReactNode;
  formatter?: (
    value: number | string | undefined,
    key: string,
    item: TooltipPayloadItem,
    index: number,
    payload: TooltipPayloadItem[],
  ) => React.ReactNode;
  className?: string;
}) {
  const { config } = useChart();

  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className={cn('bg-popover text-popover-foreground grid min-w-32 gap-1 rounded-md border px-2.5 py-1.5 text-xs shadow-md', className)}>
      {!hideLabel && payload[0] ? (
        <div className="font-medium">
          {labelFormatter
            ? labelFormatter(String(payload[0].payload?.label ?? payload[0].name ?? ''), payload)
            : payload[0].payload?.label ?? payload[0].name ?? ''}
        </div>
      ) : null}
      <div className="grid gap-1">
        {payload.map((item: TooltipPayloadItem, index: number) => {
          const key = String(item.dataKey ?? item.name ?? index);
          const itemConfig = config[key];
          const label = itemConfig?.label ?? item.name ?? key;
          const color = item.color ?? item.fill ?? `var(--color-${key})`;

          const renderedValue = formatter
            ? formatter(item.value as number, key, item, index, payload)
            : item.value;

          return (
            <div key={key} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: color }} />
                <span>{label}</span>
              </div>
              <span className="font-mono">{renderedValue as React.ReactNode}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { ChartContainer, ChartTooltip, ChartTooltipContent };
