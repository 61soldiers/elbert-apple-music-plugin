// Listening time in the unit the user picked (Auto, Hours or Minutes). Pure:
// the page code asks `unit.ts` which unit is current and passes it in.

import { formatListenMinutes, groupDigits } from '../format';

export type TimeUnit = 'auto' | 'hours' | 'minutes';

export const TIME_UNITS: { id: TimeUnit; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'hours', label: 'Hours' },
  { id: 'minutes', label: 'Minutes' },
];

export const isTimeUnit = (v: unknown): v is TimeUnit => v === 'auto' || v === 'hours' || v === 'minutes';

/** "412.5 hr" with a decimal only when it isn't a whole number. */
function hoursText(minutes: number): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  const whole = Math.trunc(hours);
  const frac = Math.round((hours - whole) * 10);
  return `${groupDigits(whole)}${frac ? `.${frac}` : ''} hr`;
}

/** A duration as a caption: "6.2 hr", "24,750 min", or Auto's "6 hr 12 min". */
export function formatMinutes(minutes: number, unit: TimeUnit): string {
  const m = Math.max(0, Math.round(minutes));
  switch (unit) {
    case 'hours':
      return hoursText(m);
    case 'minutes':
      return `${groupDigits(m)} min`;
    default:
      return formatListenMinutes(m);
  }
}

/** The big number of a hero card and what it counts, in whole units. */
export function heroTime(minutes: number, unit: TimeUnit): { value: number; unit: string } {
  const m = Math.max(0, Math.round(minutes));
  const hours = Math.floor(m / 60);
  const asHours = unit === 'hours' || (unit === 'auto' && hours > 0);
  if (asHours) return { value: hours, unit: hours === 1 ? 'hour of music' : 'hours of music' };
  return { value: m, unit: m === 1 ? 'minute of music' : 'minutes of music' };
}

/** The number and noun of a story slide: hours or minutes, whole. */
export function storyTime(minutes: number, unit: TimeUnit): { value: number; noun: string } {
  const hero = heroTime(minutes, unit);
  return { value: hero.value, noun: hero.unit.replace(' of music', '') };
}
