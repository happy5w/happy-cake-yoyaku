import { Reservation, Cake } from '../types';

const DEFAULT_SHEET_TITLE = '予約管理台帳';

/**
 * Helper to format reservation status for Japanese audience in Google Sheets
 */
function translateStatus(status: string): string {
  switch (status) {
    case 'pending': return '受付中';
    case 'confirmed': return '予約確定';
    case 'completed': return 'お渡し完了';
    case 'cancelled': return 'キャンセル';
    default: return status;
  }
}

export function buildHeaders(cakes?: Cake[]): string[] {
  const cakeHeaders = (cakes || []).map(c => c.jpName);
  return [
    'No.',
    '受付日時',
    'ステータス',
    '受取日',
    '受取時間',
    'お名前',
    'フリガナ',
    '電話番号',
    'メールアドレス',
    '予約ケーキ内訳',
    ...cakeHeaders,
    '合計個数',
    '合計金額(税込)',
    '備考',
    '最終更新日時',
  ];
}

export function buildReservationRows(reservations: Reservation[], cakes?: Cake[]): (string | number)[][] {
  return (reservations || []).map((res, index) => {
    const safeItems = Array.isArray(res.items) ? res.items : [];
    const itemsDescription = safeItems
      .map((item) => `${item.cakeName}×${item.quantity}`)
      .join('、');

    const cakeQtys = (cakes || []).map(c => {
      const found = safeItems.find(i => i.cakeId === c.id || i.cakeName === c.jpName);
      return found ? found.quantity : 0;
    });

    const totalQty = safeItems.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
    const createdStr = res.createdAt
      ? new Date(res.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : '-';
    const updatedStr = res.updatedAt
      ? new Date(res.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : '-';

    return [
      index + 1,
      createdStr,
      translateStatus(res.status),
      res.date || '-',
      res.time || '-',
      res.name || '-',
      res.nameKana || '-',
      `'${res.phone || ''}`,
      res.email || '-',
      itemsDescription || '-',
      ...cakeQtys,
      totalQty,
      Number(res.totalPrice) || 0,
      res.notes || '-',
      updatedStr,
    ];
  });
}

/**
 * Formats an A1 range with proper quoting for Japanese/spaces in sheet tab names
 */
function formatSheetRange(sheetTitle: string, cellRange: string): string {
  const escaped = (sheetTitle || DEFAULT_SHEET_TITLE).replace(/'/g, "''");
  return `'${escaped}'!${cellRange}`;
}

/**
 * Resolves the actual title of the first sheet tab in a spreadsheet.
 * Avoids hardcoding "Sheet1" which fails on Japanese locale Google accounts ("シート1").
 */
async function resolveFirstSheetTitle(accessToken: string, spreadsheetId: string): Promise<string> {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Failed to read spreadsheet metadata (${response.status}): ${errText}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const firstTitle = data?.sheets?.[0]?.properties?.title;
  return typeof firstTitle === 'string' && firstTitle.length > 0 ? firstTitle : DEFAULT_SHEET_TITLE;
}

/**
 * Creates a brand new Google Sheet specifically configured for Happy Café Reservations
 * and populates the header row (and initial reservations if provided).
 */
export async function createReservationsSheet(
  accessToken: string,
  cakes?: Cake[],
  reservations?: Reservation[]
): Promise<string> {
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title: `Happy Café ケーキ予約管理台帳 (${new Date().toLocaleDateString('ja-JP')})`,
      },
      sheets: [
        {
          properties: {
            title: DEFAULT_SHEET_TITLE,
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Google Sheets creation failed (${response.status}): ${errText}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const spreadsheetId = data?.spreadsheetId;

  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID is missing in the response.');
  }

  const createdSheetTitle =
    data?.sheets?.[0]?.properties?.title || DEFAULT_SHEET_TITLE;

  // Write headers and initial reservation rows immediately using the verified sheet tab title
  const headers = buildHeaders(cakes);
  const rows = reservations && reservations.length > 0
    ? buildReservationRows(reservations, cakes)
    : [];
  const allValues = [headers, ...rows];
  const range = encodeURIComponent(formatSheetRange(createdSheetTitle, 'A1'));

  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: allValues,
      }),
    }
  );

  if (!writeRes.ok) {
    const errText = await writeRes.text();
    const err = new Error(`Failed to write initial data to Google Sheets (${writeRes.status}): ${errText}`) as Error & { status?: number };
    err.status = writeRes.status;
    throw err;
  }

  return spreadsheetId;
}

/**
 * Synchronizes the entire list of reservations to the spreadsheet.
 * Dynamically resolves the first sheet tab name so it works regardless of locale ("シート1", "Sheet1", "予約管理台帳").
 */
export async function syncReservationsToSheet(
  accessToken: string,
  spreadsheetId: string,
  reservations: Reservation[],
  cakes?: Cake[]
): Promise<void> {
  const sheetTitle = await resolveFirstSheetTitle(accessToken, spreadsheetId);
  const clearRange = encodeURIComponent(formatSheetRange(sheetTitle, 'A1:ZZ2000'));

  // Clear old values on the first sheet tab to avoid lingering records
  const clearRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${clearRange}:clear`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );

  if (!clearRes.ok) {
    const errText = await clearRes.text();
    const err = new Error(`Failed to clear sheet range (${clearRes.status}): ${errText}`) as Error & { status?: number };
    err.status = clearRes.status;
    throw err;
  }

  const headers = buildHeaders(cakes);
  const rows = buildReservationRows(reservations, cakes);
  const allValues = [headers, ...rows];
  const writeRange = encodeURIComponent(formatSheetRange(sheetTitle, 'A1'));

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${writeRange}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: allValues,
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Failed to synchronize reservation records (${response.status}): ${errText}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
}

/**
 * Extracts a Google Spreadsheet ID from either a full Google Sheets URL or a raw ID string.
 */
export function extractSpreadsheetId(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }
  if (/^[a-zA-Z0-9-_]{15,}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Exports all reservations as a UTF-8 BOM CSV file that can be opened directly in Google Sheets or Excel.
 */
export function downloadReservationsCsv(reservations: Reservation[], cakes?: Cake[]): void {
  const headers = buildHeaders(cakes);
  const rows = buildReservationRows(reservations, cakes).map(row =>
    row.map(cell => {
      const str = String(cell ?? '').replace(/^'/, '');
      const escaped = str.replace(/"/g, '""');
      return `"${escaped}"`;
    })
  );

  const csvHeader = headers.map(h => `"${h.replace(/"/g, '""')}"`).join(',');
  const csvBody = rows.map(r => r.join(',')).join('\r\n');
  const csvContent = `\uFEFF${csvHeader}\r\n${csvBody}`;

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const dateStr = new Date().toISOString().split('T')[0];
  link.href = url;
  link.setAttribute('download', `happy_cafe_reservations_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Copies all reservations in TSV (Tab-Separated Values) format to the clipboard
 * so the user can paste (Ctrl+V / Cmd+V) directly into cell A1 of any Google Spreadsheet.
 */
export async function copyReservationsForSheets(reservations: Reservation[], cakes?: Cake[]): Promise<number> {
  const headers = buildHeaders(cakes);
  const rows = buildReservationRows(reservations, cakes).map(row =>
    row.map(cell => String(cell ?? '').replace(/^'/, '').replace(/[\t\r\n]+/g, ' ')).join('\t')
  );
  const tsv = [headers.join('\t'), ...rows].join('\n');
  await navigator.clipboard.writeText(tsv);
  return rows.length;
}
