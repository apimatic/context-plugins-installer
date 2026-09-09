// What `doctor` found. Every check is a result rather than a throw, so one
// broken check still reports alongside the rest.

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  status: DoctorStatus;
  label: string;
  detail: string;
  hint?: string;
}

export interface DoctorGroup {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  groups: DoctorGroup[];
  failures: number;
  warnings: number;
  ok: boolean;
}
