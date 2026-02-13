// src/unified-executor.ts
import { executeClaudeTask, ExecutorOptions, ExecutionResult } from './executor.js';
import { executeOpenAITask } from './openai-provider.js';
import { getGatewayClient } from './openclaw-gateway.js';
import { getChatGPTBrowserClient } from './chatgpt-browser.js';
import type { Config } from './config.js';
import { ToolExecutor } from './tool-executor.js';

export type Provider = 'claude' | 'openai';

export interface UnifiedExecutorOptions extends ExecutorOptions {
  provider?: Provider;
  toolExecutor?: ToolExecutor;
  imagePath?: string; // 이미지 포함 요청 시 로컬 파일 경로
}

export interface UnifiedExecutionResult extends ExecutionResult {
  provider: Provider;
}

/**
 * OpenAI 요청을 처리합니다.
 *
 * 전략 (우선순위):
 * 1. ChatGPT Browser: Playwright + Chrome으로 직접 API 호출 (~2-5초)
 * 2. OpenClaw Gateway: WebSocket 게이트웨이 사용 (~2-4초)
 * 3. Codex CLI: 서브프로세스 fallback (~13-18초)
 */
async function executeOpenAIWithGateway(
  options: UnifiedExecutorOptions,
  config: Config
): Promise<UnifiedExecutionResult> {
  // [1순위] ChatGPT Browser (Playwright)
  if (config.chatgptBrowser?.enabled) {
    try {
      const client = getChatGPTBrowserClient(config.chatgptBrowser);

      const result = await client.sendMessage(options.prompt, {
        model: config.chatgptBrowser.model,
        timeout: options.timeout || config.chatgptBrowser.timeout,
        systemPrompt: options.systemPrompt,
        toolExecutor: options.toolExecutor,
        imagePath: options.imagePath,
      });

      return {
        output: result.text,
        sessionId: '',
        success: true,
        provider: 'openai',
      };
    } catch (err: any) {
      console.error('[unified-executor] ChatGPT Browser 실패:', err.message);
      // fallback to gateway below
    }
  }

  // [2순위] OpenClaw Gateway (WebSocket)
  if (config.openclawGateway?.enabled) {
    try {
      const client = getGatewayClient(config.openclawGateway);
      const result = await client.sendMessage(options.prompt, {
        sessionId: config.openclawGateway.sessionId,
        timeout: options.timeout || config.openclawGateway.timeout,
      });

      return {
        output: result.text,
        sessionId: config.openclawGateway.sessionId || '',
        success: true,
        provider: 'openai',
      };
    } catch (err: any) {
      console.error('[unified-executor] Gateway 실패, Codex CLI fallback:', err.message);
      // fallback to Codex CLI below
    }
  }

  // [3순위] Fallback: Codex CLI 서브프로세스
  if (!config.openai?.enabled) {
    return {
      output: 'OpenAI가 설정에서 활성화되지 않았습니다.',
      sessionId: '',
      success: false,
      error: 'OpenAI not enabled',
      provider: 'openai',
    };
  }

  const result = await executeOpenAITask(
    {
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      model: config.openai.model,
      maxTokens: config.openai.maxTokens,
    },
    config.openai
  );

  return {
    output: result.output,
    sessionId: '',
    success: result.success,
    error: result.error,
    provider: 'openai',
  };
}

export async function executeTask(
  options: UnifiedExecutorOptions,
  config: Config
): Promise<UnifiedExecutionResult> {
  const provider = options.provider || config.defaultProvider || 'claude';

  if (provider === 'openai') {
    return executeOpenAIWithGateway(options, config);
  }

  // Default: Claude
  const result = await executeClaudeTask(options, config.claude);
  return {
    ...result,
    provider: 'claude',
  };
}
