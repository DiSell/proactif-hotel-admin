import type { ReactNode } from "react";
import { Card } from "./Card";

export interface DataTableColumn<T> {
  header: string;
  width?: string;
  align?: "left" | "right" | "center";
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick }: DataTableProps<T>) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-4 border-b border-border px-6 py-3">
        {columns.map((col, index) => (
          <span
            key={index}
            style={{ width: col.width, flex: col.width ? undefined : 1, textAlign: col.align }}
            className="text-2xs font-medium uppercase tracking-wide text-body/65"
          >
            {col.header}
          </span>
        ))}
      </div>
      {rows.map((row, index) => (
        <div
          key={rowKey(row)}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
          className={`flex items-center gap-4 px-6 py-3.5 ${index > 0 ? "border-t border-border" : ""} ${
            onRowClick ? "cursor-pointer hover:bg-canvas" : ""
          }`}
        >
          {columns.map((col, index) => (
            <div key={index} style={{ width: col.width, flex: col.width ? undefined : 1, textAlign: col.align }}>
              {col.render(row)}
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}
