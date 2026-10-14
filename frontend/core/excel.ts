/**
 * Exportación a Excel (.xlsx) generada en el navegador: no consume CPU del
 * servidor gratuito ni requiere servicios externos.
 */

export interface ExcelColumn<TRow> {
  header: string;
  width: number;
  value: (row: TRow) => string | number | null;
  isMoney?: boolean;
}

const HEADER_STYLE = { fontWeight: 'bold', backgroundColor: '#3f6f68', color: '#ffffff' } as const;

export async function downloadExcel<TRow>(fileName: string, sheetName: string, rows: TRow[], columns: ExcelColumn<TRow>[]): Promise<void> {
  const headerRow = columns.map((column) => ({ value: column.header, ...HEADER_STYLE }));
  const dataRows = rows.map((row) =>
    columns.map((column) => {
      const value = column.value(row);
      if (typeof value === 'number') {
        return { value, type: Number, format: column.isMoney ? '$#,##0' : undefined };
      }
      return { value: value ?? '', type: String };
    }),
  );

  // Carga diferida: la librería solo se descarga cuando alguien exporta.
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  await writeXlsxFile([headerRow, ...dataRows] as never, {
    sheet: sheetName.slice(0, 31),
    columns: columns.map((column) => ({ width: column.width })),
    stickyRowsCount: 1,
  } as never).toFile(`${fileName}.xlsx`);
}
