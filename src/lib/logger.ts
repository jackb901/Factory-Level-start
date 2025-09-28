type Level = 'debug' | 'info' | 'warn' | 'error';

type BaseLog = {
  timestamp: string;
  level: Level;
  event: string;
  request_id?: string;
  tenant_id?: string;
  job_id?: string;
  doc_id?: string;
  stage?: string;
  step?: string;
  duration_ms?: number;
};

export function log(event: string, data: Record<string, unknown> = {}, level: Level = 'info') {
  const payload: BaseLog & Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  try {
    // Do not log secrets; callers must redact before passing.
    console.log(JSON.stringify(payload));
  } catch {
    console.log(
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event: 'logger_failed' })
    );
  }
}
