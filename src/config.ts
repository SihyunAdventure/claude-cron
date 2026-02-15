import { parse } from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

export interface ClaudeConfig {
  binary: string;
  model?: string;
  maxTokens?: number;
  defaultTimeout: number;
  outputFormat: string;
  allowedTools: string[];
  extraArgs?: string[];
}

export interface MemoryConfig {
  enabled: boolean;
  dir: string;
  systemPromptFile?: string;
}

export interface TelegramNotificationConfig {
  token: string;
  chatId: string;
}

export interface SlackNotificationConfig {
  webhookUrl: string;
}

export interface NotificationsConfig {
  telegram?: TelegramNotificationConfig;
  slack?: SlackNotificationConfig;
}

export interface TelegramBotConfig {
  enabled: boolean;
  allowedChatIds: string[];
  defaultWorkdir: string;
}

export interface ActiveHoursConfig {
  start: string;
  end: string;
  timezone: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  file: string;
  cron: string;
  activeHours?: ActiveHoursConfig;
}

export interface SessionsConfig {
  dir: string;
  ttlHours: number;
}

export interface LoggingConfig {
  dir: string;
  retention: number;
}

export interface OpenAIConfig {
  enabled: boolean;
  binary?: string;
  model: string;
  maxTokens: number;
  defaultTimeout?: number;
  apiKey?: string;
  useOAuth?: boolean;
}

export interface ChatGPTBrowserConfig {
  enabled: boolean;
  model?: string;       // e.g. gpt-5.3-codex-spark
  timeout?: number;     // request timeout in ms (default: 30000)
  headless?: boolean;   // Chrome headless 모드 (default: true)
  cdpPort?: number;     // CDP 디버깅 포트 (default: 19222)
}

export interface GoogleCalendarConfig {
  enabled: boolean;
  credentialsFile?: string; // 기본: config/google-credentials.json
}

export interface Config {
  claude: ClaudeConfig;
  openai?: OpenAIConfig;
  chatgptBrowser?: ChatGPTBrowserConfig;
  googleCalendar?: GoogleCalendarConfig;
  memory: MemoryConfig;
  notifications: NotificationsConfig;
  telegramBot: TelegramBotConfig;
  heartbeat: HeartbeatConfig;
  sessions: SessionsConfig;
  logging: LoggingConfig;
  defaultProvider?: 'claude' | 'openai';
}

/**
 * Substitutes environment variables in a string.
 * Replaces ${VAR_NAME} with process.env.VAR_NAME
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not defined`);
    }
    return envValue;
  });
}

/**
 * Recursively processes config object to substitute environment variables
 */
function processConfigValue(value: any): any {
  if (typeof value === 'string') {
    return substituteEnvVars(value);
  } else if (Array.isArray(value)) {
    return value.map(processConfigValue);
  } else if (value !== null && typeof value === 'object') {
    const processed: any = {};
    for (const [key, val] of Object.entries(value)) {
      processed[key] = processConfigValue(val);
    }
    return processed;
  }
  return value;
}

/**
 * Resolves relative paths in config to absolute paths
 */
function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(process.env.HOME || process.env.USERPROFILE || '~', p.slice(1));
  }
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

function resolvePaths(config: Config): Config {
  return {
    ...config,
    memory: config.memory ? {
      ...config.memory,
      dir: resolvePath(config.memory.dir),
      systemPromptFile: config.memory.systemPromptFile
        ? resolvePath(config.memory.systemPromptFile)
        : undefined,
    } : { enabled: false, dir: path.resolve(PROJECT_ROOT, 'memory') },
    heartbeat: {
      ...config.heartbeat,
      file: path.isAbsolute(config.heartbeat.file)
        ? config.heartbeat.file
        : path.resolve(PROJECT_ROOT, config.heartbeat.file),
    },
    sessions: {
      ...config.sessions,
      dir: path.isAbsolute(config.sessions.dir)
        ? config.sessions.dir
        : path.resolve(PROJECT_ROOT, config.sessions.dir),
    },
    logging: {
      ...config.logging,
      dir: path.isAbsolute(config.logging.dir)
        ? config.logging.dir
        : path.resolve(PROJECT_ROOT, config.logging.dir),
    },
    telegramBot: {
      ...config.telegramBot,
      defaultWorkdir: config.telegramBot.defaultWorkdir.startsWith('~')
        ? path.join(
            process.env.HOME || process.env.USERPROFILE || '~',
            config.telegramBot.defaultWorkdir.slice(1)
          )
        : path.isAbsolute(config.telegramBot.defaultWorkdir)
        ? config.telegramBot.defaultWorkdir
        : path.resolve(PROJECT_ROOT, config.telegramBot.defaultWorkdir),
    },
  };
}

/**
 * Loads and parses the YAML configuration file with environment variable substitution
 */
export function loadConfig(configPath?: string): Config {
  const configFilePath =
    configPath || path.resolve(PROJECT_ROOT, 'config', 'config.yaml');

  if (!fs.existsSync(configFilePath)) {
    throw new Error(`Config file not found: ${configFilePath}`);
  }

  const configContent = fs.readFileSync(configFilePath, 'utf-8');
  const rawConfig = parse(configContent);

  // Process environment variables
  const processedConfig = processConfigValue(rawConfig);

  // Resolve relative paths
  const config = resolvePaths(processedConfig as Config);

  // Validate required fields
  if (!config.claude?.binary) {
    throw new Error('Config validation failed: claude.binary is required');
  }

  return config;
}
