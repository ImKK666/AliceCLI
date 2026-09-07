const MODEL_EMAIL_MAP: Array<{ keywords: string[]; email: string }> = [
  { keywords: ['claude'], email: 'noreply@alice-cli.dev' },
  // 由于找不到他们的邮箱和头像, 所以改为了使用我们的邮箱先记录, 后续官方有 github 能用的邮箱可以替换
  // github 组织是不能用 co author 的
  {
    keywords: ['gpt', 'dall-e', 'o1-', 'o3-', 'o4-'],
    email: 'openai@alice-cli.dev',
  },
  { keywords: ['gemini'], email: 'google-gemini@alice-cli.dev' },
  { keywords: ['grok'], email: 'xai-org@alice-cli.dev' },
  { keywords: ['glm'], email: 'zai-org@alice-cli.dev' },
  { keywords: ['deepseek'], email: 'deepseek-ai@alice-cli.dev' },
  { keywords: ['qwen'], email: 'QwenLM@alice-cli.dev' },
  { keywords: ['minimax'], email: 'MiniMax-AI@alice-cli.dev' },
  { keywords: ['mimo'], email: 'XiaomiMiMo@alice-cli.dev' },
  { keywords: ['kimi'], email: 'MoonshotAI@alice-cli.dev' },
]

export function getAttributionEmail(modelName: string): string {
  const lower = modelName.toLowerCase()
  for (const { keywords, email } of MODEL_EMAIL_MAP) {
    if (keywords.some(kw => lower.includes(kw))) {
      return email
    }
  }
  return 'noreply@alice-cli.dev'
}
