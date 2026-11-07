// Small text helpers shared by the pages.

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** "1 hr 03 min", "48 min", "40 sec" — Elbert's `formatReadableDuration`, which its detail headers use. */
export function formatReadableDuration(ms: number): string {
  if (!ms || ms <= 0) return '0 min';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} hr ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min`;
  return `${total % 60} sec`;
}

/** "1 song", "12 songs" — Elbert's `formatCount`. */
export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

export function formatListenMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) return `${hours} hr`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function groupDigits(value: number): string {
  return Math.max(0, Math.round(value))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** File-name-safe text, as the downloader names folders and files. */
export function sanitize(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'Untitled';
}
