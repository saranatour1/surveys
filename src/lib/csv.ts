function escapeCsvValue(value: string): string {
  if (/[\",\\n\\r]/.test(value)) {
    return `\"${value.replace(/\"/g, '\"\"')}\"`;
  }
  return value;
}

export function buildCsvString(headers: string[], rows: string[][]): string {
  const headerLine = headers.map((cell) => escapeCsvValue(cell ?? '')).join(',');
  const bodyLines = rows.map((row) => row.map((cell) => escapeCsvValue(cell ?? '')).join(','));
  return [headerLine, ...bodyLines].join('\\n');
}

export function triggerCsvDownload(filename: string, csvContent: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
