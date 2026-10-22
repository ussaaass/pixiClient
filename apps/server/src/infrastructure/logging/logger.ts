/**
 * 结构化日志。
 *
 * 依据 `docs/02_architecture/HTTP接口与共享DTO协议SDD.md` §11：
 * 日志记录 requestId、route template、HTTP status、business code、耗时和脱敏 actor ID；
 * **不记录** Bearer token、密码、TOTP、完整支付凭证/地址、客服附件密钥或完整私人 DTO。
 *
 * 输出为单行 JSON（便于容器日志采集与按字段检索），而非自由格式文本。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 单条日志的字段集合。除 level/message/timestamp 外均可选。 */
export interface LogFields {
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  code?: string;
  durationMs?: number;
  /** 已脱敏的 actor 标识（例如 `user:1001`），禁止放入原始 userId 之外的身份信息。 */
  actor?: string;
  /** 领域错误码或内部异常名；不含堆栈与原始 message。 */
  errorCode?: string;
  retryable?: boolean;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** 派生一个带固定字段的子 logger（例如绑定 requestId）。 */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** 低于该级别的日志不输出。默认 `info`。 */
  level?: LogLevel;
  /** 输出目标。默认写 stdout；测试可注入内存 sink。 */
  sink?: (line: string) => void;
  /** 附加到每条日志的固定字段（如 serviceName、version）。 */
  base?: LogFields;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 需要在日志中屏蔽的字段名（小写匹配）。
 * 即使调用方误传，也不会被序列化到输出。
 */
const REDACTED_FIELD_NAMES = new Set([
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'totp',
  'otp',
  'apikey',
  'api_key',
  'credential',
  'cookie',
  'setcookie',
  'set_cookie',
  'privatekey',
  'private_key',
  'clientsecret',
  'client_secret',
]);

const REDACTED_VALUE = '[REDACTED]';

function redact(fields: LogFields): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    output[key] = REDACTED_FIELD_NAMES.has(key.toLowerCase()) ? REDACTED_VALUE : value;
  }
  return output;
}

/** 构造一个结构化 logger。 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? defaultSink;
  const base = options.base ?? {};
  const threshold = LEVEL_WEIGHT[level];

  function write(entryLevel: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return;
    const payload = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message,
      ...redact({ ...base, ...fields }),
    };
    sink(JSON.stringify(payload));
  }

  const logger: Logger = {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger({ level, sink, base: { ...base, ...fields } }),
  };

  return logger;
}

/** 供测试使用的内存 sink。 */
export function createMemorySink(): { sink: (line: string) => void; lines: string[]; records: LogFields[] } {
  const lines: string[] = [];
  const records: LogFields[] = [];
  return {
    lines,
    records,
    sink: (line: string) => {
      lines.push(line);
      records.push(JSON.parse(line) as LogFields);
    },
  };
}
