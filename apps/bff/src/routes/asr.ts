import { Hono } from 'hono';

export const asrRoutes = new Hono();

// §1.2 & §8.1：本期留口，界面不暴露入口
asrRoutes.post('/', (c) => {
  return c.json(
    { error: { code: 'NOT_IMPLEMENTED', message: '服务端 ASR 暂未开放，当前使用浏览器本地实时字幕与录音' } },
    501
  );
});
