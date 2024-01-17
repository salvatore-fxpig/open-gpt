import { DEFAULT_SYSTEM_PROMPT } from '@/utils/app/const';
import { OpenAIStream } from '@/utils/server';
import { createMessagesToSend } from '@/utils/server/message';
import { getTiktokenEncoding } from '@/utils/server/tiktoken';


import cookie from "cookie"
import { getUserHashFromMail } from '@/utils/server/auth';
import { saveLlmUsage, verifyUserLlmUsage } from '@/utils/server/llmUsage';
import { closeClient } from '@/utils/server/storage';
import { hkdfSync } from 'crypto';
import { compactDecrypt } from "jose"

const nextAuthSecret = process.env.NEXTAUTH_SECRET
const info = "NextAuth.js Generated Encryption Key"
const nextAuthKey = nextAuthSecret ? hkdfSync("sha256", nextAuthSecret, "", info, 32) : undefined;

const close = async (status?: number, error?: unknown) => {
  await closeClient();
  if (error)
    return new Response(JSON.stringify({error}), {status,"headers": { "content-type": "application/json" } })
}

// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: Request) => {
  let mail = "dummy@dummy.com"
  if (nextAuthKey) {
    const { "__Secure-next-auth.session-token": token } = cookie.parse(req.headers.get("cookie") ?? "");
    try {
      const { plaintext } = await compactDecrypt(token, new Uint8Array(nextAuthKey));
      const payload = JSON.parse(Buffer.from(plaintext).toString("utf-8"));
      if (typeof payload.email === "string")
        mail = payload.email;
    } catch (err) {
      console.error(err);
      return close(401, "Unauthorized");
    }
  }
  const userId = getUserHashFromMail(mail);


  const { model, messages, key, prompt, temperature } = await req.json()

  try {
    await verifyUserLlmUsage(userId, model.id);
  } catch (e: any) {
    return close(429, e.message);
  }

  const encoding = await getTiktokenEncoding(model.id);

  let systemPromptToSend = prompt;
  if (!systemPromptToSend) {
    systemPromptToSend = DEFAULT_SYSTEM_PROMPT;
  }
  let { messages: messagesToSend, maxToken, tokenCount } = createMessagesToSend(
    encoding,
    model,
    systemPromptToSend,
    1000,
    messages,
  );
  if (messagesToSend.length === 0) {
    throw new Error('message is too long');
  }
  const stream = await OpenAIStream(
    model,
    systemPromptToSend,
    temperature,
    key,
    messagesToSend,
    maxToken,
  );
  let responseText = "";
  const tokenCounter = new TransformStream({
    transform(chunk, controller) {
      responseText += Buffer.from(chunk).toString("utf-8");
      controller.enqueue(chunk);
    },
    async flush() {
      const completionTokenCount = encoding.encode(responseText).length;
      await saveLlmUsage(userId, model.id, "chat", {
        prompt: tokenCount,
        completion: completionTokenCount,
        total: tokenCount + completionTokenCount
      })
      await close();
    }
  })
  return new Response(stream.pipeThrough(tokenCounter));
};
