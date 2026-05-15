"use client";

import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import {
  flexRender,
  type Table as ReactTable,
  type Row,
} from "@tanstack/react-table";

import { cn } from "../lib/utils";
import { Button } from "./button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

type DataTableProps<TData> = {
  emptyMessage: string;
  onRowClick?: (row: Row<TData>) => void;
  table: ReactTable<TData>;
};

type DataTablePaginationProps<TData> = {
  label: string;
  table: ReactTable<TData>;
};

export function DataTable<TData>({
  emptyMessage,
  onRowClick,
  table,
}: DataTableProps<TData>) {
  const rows = table.getRowModel().rows;
  const columnCount = table.getAllLeafColumns().length;

  return (
    <div className="overflow-hidden border border-[var(--mesh-line)] bg-black/20">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow
              className="border-[var(--mesh-line)] hover:bg-transparent"
              key={headerGroup.id}
            >
              {headerGroup.headers.map((header) => (
                <TableHead
                  className="h-11 px-3 text-xs font-bold tracking-normal text-[var(--mesh-muted)] uppercase"
                  key={header.id}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length > 0 ? (
            rows.map((row) => (
              <TableRow
                className={cn(
                  "border-[var(--mesh-line)] text-[var(--mesh-white)] hover:bg-white/[0.04]",
                  onRowClick !== undefined && "cursor-pointer",
                )}
                data-state={row.getIsSelected() ? "selected" : undefined}
                key={row.id}
                tabIndex={onRowClick === undefined ? undefined : 0}
                onClick={
                  onRowClick === undefined ? undefined : () => onRowClick(row)
                }
                onKeyDown={
                  onRowClick === undefined
                    ? undefined
                    : (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                }
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell className="max-w-80 px-3 py-3" key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow className="hover:bg-transparent">
              <TableCell
                className="h-32 px-3 text-center text-[var(--mesh-muted)]"
                colSpan={columnCount}
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export function DataTablePagination<TData>({
  label,
  table,
}: DataTablePaginationProps<TData>) {
  const pageCount = Math.max(table.getPageCount(), 1);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--mesh-muted)]">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <Button
          aria-label="Previous page"
          disabled={!table.getCanPreviousPage()}
          size="icon-sm"
          type="button"
          onClick={() => table.previousPage()}
        >
          <IconChevronLeft aria-hidden="true" />
        </Button>
        <span className="min-w-24 text-center">
          Page {table.getState().pagination.pageIndex + 1} of {pageCount}
        </span>
        <Button
          aria-label="Next page"
          disabled={!table.getCanNextPage()}
          size="icon-sm"
          type="button"
          onClick={() => table.nextPage()}
        >
          <IconChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
