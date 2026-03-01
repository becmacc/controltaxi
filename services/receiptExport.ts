import { ReceiptRecord } from '../types';

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const formatIssuedAt = (issuedAt: string): string => {
  const timestamp = new Date(issuedAt);
  if (!Number.isFinite(timestamp.getTime())) return issuedAt;
  return timestamp.toLocaleString();
};

export const exportReceiptPdfFriendly = (
  receipt: ReceiptRecord,
  options?: {
    companyName?: string;
    partyPhone?: string;
    extraNotes?: string;
  }
): boolean => {
  if (typeof window === 'undefined') return false;

  const companyName = options?.companyName || 'Control Taxi';
  const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=860,height=980');
  if (!printWindow) return false;

  const printableHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Receipt ${escapeHtml(receipt.receiptNumber)}</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; margin: 32px; color: #0f172a; }
      .card { border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; max-width: 720px; margin: 0 auto; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
      .title { font-size: 26px; font-weight: 800; margin: 0; letter-spacing: 0.04em; }
      .sub { color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }
      .row { display: flex; justify-content: space-between; border-bottom: 1px solid #f1f5f9; padding: 10px 0; gap: 12px; }
      .label { color: #475569; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
      .value { color: #0f172a; font-size: 14px; font-weight: 700; text-align: right; }
      .amount { font-size: 28px; font-weight: 900; color: #059669; }
      .footer { margin-top: 22px; color: #475569; font-size: 12px; line-height: 1.5; }
      @media print { body { margin: 0; } .card { border: none; max-width: none; border-radius: 0; } }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        <div>
          <h1 class="title">Receipt</h1>
          <div class="sub">${escapeHtml(companyName)}</div>
        </div>
        <div class="sub">#${escapeHtml(receipt.receiptNumber)}</div>
      </div>

      <div class="row"><div class="label">Party</div><div class="value">${escapeHtml(receipt.partyName)}</div></div>
      <div class="row"><div class="label">Party Type</div><div class="value">${escapeHtml(receipt.partyType)}</div></div>
      <div class="row"><div class="label">Cycle</div><div class="value">${escapeHtml(receipt.cycle)}</div></div>
      ${options?.partyPhone ? `<div class="row"><div class="label">Phone</div><div class="value">${escapeHtml(options.partyPhone)}</div></div>` : ''}
      <div class="row"><div class="label">Issued At</div><div class="value">${escapeHtml(formatIssuedAt(receipt.issuedAt))}</div></div>
      <div class="row"><div class="label">Ledger Reference</div><div class="value">${escapeHtml(receipt.ledgerEntryId)}</div></div>

      <div class="row" style="border-bottom:none; margin-top: 12px;">
        <div class="label">Amount</div>
        <div class="amount">$${escapeHtml(receipt.amountUsd.toFixed(2))}</div>
      </div>

      ${(receipt.notes || options?.extraNotes) ? `<div class="footer"><strong>Notes:</strong> ${escapeHtml(receipt.notes || options?.extraNotes || '')}</div>` : ''}
      <div class="footer">Generated from operational system. Use browser Print → Save as PDF to share with customer.</div>
    </div>
    <script>
      window.addEventListener('load', () => {
        window.focus();
        window.print();
      });
    </script>
  </body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(printableHtml);
  printWindow.document.close();
  return true;
};
