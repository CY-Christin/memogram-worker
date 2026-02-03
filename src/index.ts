type Env = {
  BOT_TOKEN: string;
  MEMOS_TOKEN: string;
  MEMOS_BASE_URL: string;
  WEBHOOK_URL?: string;
  PAGE_SIZE?: string;
  SHOW_MEDIA?: string;
  MEDIA_GROUPS?: KVNamespace;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
  entities?: TelegramEntity[];
  caption?: string;
  caption_entities?: TelegramEntity[];
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramFile;
  voice?: TelegramFile;
  video?: TelegramFile;
  forward_origin?: TelegramForwardOrigin;
};

type TelegramEntity = {
  type: "url" | "text_link" | "bold" | "italic" | string;
  offset: number;
  length: number;
  url?: string;
};

type TelegramFile = {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
};

type TelegramPhotoSize = {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
};

type TelegramForwardOrigin =
  | { type: "user"; sender_user?: { first_name: string; last_name?: string; username?: string } }
  | { type: "hidden_user"; sender_user_name?: string }
  | { type: "chat"; sender_chat?: { title?: string; username?: string } }
  | { type: "channel"; chat?: { title?: string; username?: string } };

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  from: { id: number; username?: string };
  message?: TelegramCallbackMessage;
};

type TelegramCallbackMessage = {
  message_id: number;
  chat: { id: number };
};

type MemosListResponse = {
  memos: MemosMemo[];
  nextPageToken?: string;
};

type MemosMemo = {
  name: string;
  content: string;
  visibility?: "PUBLIC" | "PROTECTED" | "PRIVATE";
  pinned?: boolean;
  tags?: string[];
  displayTime?: string;
  updateTime?: string;
  createTime?: string;
  attachments?: MemosAttachment[];
  snippet?: string;
};

type MemosAttachment = {
  name: string;
  filename: string;
  type: string;
  size: string | number;
  externalLink?: string;
};

type CallbackPayload =
  | { a: "list"; token?: string; hist?: string[] }
  | { a: "detail"; memoId: string; token?: string; hist?: string[] }
  | { a: "vis"; memoId: string; v: "PUBLIC" | "PROTECTED" | "PRIVATE"; token?: string; hist?: string[] }
  | { a: "pin"; memoId: string; token?: string; hist?: string[] };

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_DETAIL_MEDIA = 10;
const MAX_CAPTION_LEN = 900;
const MAX_MESSAGE_LEN = 3900;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (url.pathname === "/telegram/setup") {
      return handleSetup(request, env);
    }
    if (url.pathname === "/telegram/webhook") {
      return handleWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function handleSetup(request: Request, env: Env): Promise<Response> {
  const webhookUrl = env.WEBHOOK_URL || new URL("/telegram/webhook", request.url).toString();
  const setWebhook = await telegramRequest(env, "setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
  });

  const setCommands = await telegramRequest(env, "setMyCommands", {
    commands: [
      { command: "list", description: "List memos" },
      { command: "help", description: "Help" },
    ],
  });

  return jsonResponse({
    webhookUrl,
    setWebhook,
    setCommands,
  });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (update.message) {
    await handleMessage(env, update.message);
  } else if (update.callback_query) {
    await handleCallback(env, update.callback_query);
  }

  return new Response("ok");
}

async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  try {
    const text = message.text?.trim() || "";

    if (text.startsWith("/help") || text.startsWith("/start")) {
      await sendMessage(env, chatId, [
        "Memogram Worker",
        "Commands:",
        "/list - List memos",
        "Send a message to create a memo",
      ].join("\n"));
      return;
    }

    if (text.startsWith("/list")) {
      await sendListPage(env, {
        chatId,
        pageToken: "",
        history: [],
        messageId: undefined,
      });
      return;
    }

    const content = buildMessageContent(message);
    const files = collectFiles(message);
    if (!content && files.length === 0) {
      await sendMessage(env, chatId, "Please input memo content");
      return;
    }

    const memoState = await getOrCreateMemoState(env, message, content);
    const memo = memoState.memo;
    for (const file of files) {
      const skipped = await maybeSkipLargeFile(env, chatId, file);
      if (skipped) {
        continue;
      }
      const downloaded = await downloadTelegramFile(env, file);
      if (!downloaded) {
        await sendMessage(env, chatId, `Failed to download ${file.label}`);
        continue;
      }
      await memosCreateAttachment(env, memo.name, downloaded);
    }

    if (memoState.shouldNotify) {
      const link = memoLink(env, memo.name);
      await sendMessage(env, chatId, `Saved memo: ${link}`);
      await markMediaGroupNotified(env, memoState);
    }
  } catch (err) {
    console.error("handleMessage failed", err);
    const messageText = err instanceof Error ? err.message : "Unknown error";
    await sendMessage(env, chatId, `Failed to save memo: ${messageText}`);
  }
}

async function handleCallback(env: Env, query: TelegramCallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) {
    return;
  }
  try {
    if (!query.data) {
      await answerCallback(env, query.id, "Invalid action");
      return;
    }

    const payload = decodeCallback(query.data);
    if (!payload) {
      await answerCallback(env, query.id, "Invalid action");
      return;
    }

    if (payload.a === "list") {
      await sendListPage(env, {
        chatId,
        pageToken: payload.token || "",
        history: payload.hist || [],
        messageId,
      });
      return;
    }

    if (payload.a === "detail") {
      if (!payload.memoId) {
        await answerCallback(env, query.id, "Action expired");
        return;
      }
      const memoName = memoNameFromId(payload.memoId);
      await sendDetail(env, {
        chatId,
        memoName,
      });
      await answerCallback(env, query.id, "");
      return;
    }

    if (payload.a === "vis") {
      if (!payload.memoId) {
        await answerCallback(env, query.id, "Action expired");
        return;
      }
      const memoName = memoNameFromId(payload.memoId);
      await updateMemoVisibility(env, memoName, payload.v);
      await sendDetail(env, {
        chatId,
        memoName,
      });
      return;
    }

    if (payload.a === "pin") {
      if (!payload.memoId) {
        await answerCallback(env, query.id, "Action expired");
        return;
      }
      const memoName = memoNameFromId(payload.memoId);
      await toggleMemoPinned(env, memoName);
      await sendDetail(env, {
        chatId,
        memoName,
      });
      return;
    }
  } catch (err) {
    console.error("handleCallback failed", err);
    const messageText = err instanceof Error ? err.message : "Unknown error";
    await answerCallback(env, query.id, `Action failed: ${messageText}`);
  }
}

function buildMessageContent(message: TelegramMessage): string {
  let content = message.text || "";
  let entities = message.entities || [];
  if (message.caption) {
    content = message.caption;
    entities = message.caption_entities || [];
  }

  if (entities.length > 0) {
    content = formatContent(content, entities);
  }

  if (message.forward_origin) {
    const prefix = forwardOriginPrefix(message.forward_origin);
    if (prefix) {
      content = `${prefix}\n${content}`;
    }
  }

  return content.trim();
}

async function getOrCreateMemoState(
  env: Env,
  message: TelegramMessage,
  content: string
): Promise<{ memo: MemosMemo; shouldNotify: boolean; groupId?: string; state?: MediaGroupState }> {
  const groupId = message.media_group_id;
  if (groupId && env.MEDIA_GROUPS) {
    let state = await loadMediaGroupState(env, groupId);
    if (state?.memoName) {
      try {
        const memo = await memosGetMemo(env, state.memoName);
        return { memo, shouldNotify: !state.notified, groupId, state };
      } catch {
        state = undefined;
      }
    }

    const memo = await memosCreateMemo(env, content || "");
    state = { memoName: memo.name, notified: false };
    await env.MEDIA_GROUPS.put(groupId, JSON.stringify(state), { expirationTtl: 3600 });
    return { memo, shouldNotify: true, groupId, state };
  }

  const memo = await memosCreateMemo(env, content || "");
  return { memo, shouldNotify: true };
}

type MediaGroupState = {
  memoName: string;
  notified?: boolean;
};

async function loadMediaGroupState(env: Env, groupId: string): Promise<MediaGroupState | undefined> {
  if (!env.MEDIA_GROUPS) {
    return undefined;
  }
  const raw = await env.MEDIA_GROUPS.get(groupId);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as MediaGroupState;
    if (parsed && parsed.memoName) {
      return parsed;
    }
  } catch {
    return { memoName: raw };
  }
  return undefined;
}

async function markMediaGroupNotified(
  env: Env,
  state: { groupId?: string; state?: MediaGroupState; memo?: MemosMemo }
): Promise<void> {
  if (!env.MEDIA_GROUPS || !state.groupId || !state.state) {
    return;
  }
  if (state.state.notified) {
    return;
  }
  const updated: MediaGroupState = { memoName: state.state.memoName, notified: true };
  await env.MEDIA_GROUPS.put(state.groupId, JSON.stringify(updated), { expirationTtl: 3600 });
}

function collectFiles(message: TelegramMessage): Array<{ fileId: string; label: string; size?: number; filename?: string; mimeType?: string }> {
  const files: Array<{ fileId: string; label: string; size?: number; filename?: string; mimeType?: string }> = [];

  if (message.document) {
    files.push({
      fileId: message.document.file_id,
      label: message.document.file_name || "document",
      size: message.document.file_size,
      filename: message.document.file_name,
      mimeType: message.document.mime_type,
    });
  }
  if (message.voice) {
    files.push({
      fileId: message.voice.file_id,
      label: "voice",
      size: message.voice.file_size,
      filename: "voice.ogg",
      mimeType: message.voice.mime_type || "audio/ogg",
    });
  }
  if (message.video) {
    files.push({
      fileId: message.video.file_id,
      label: "video",
      size: message.video.file_size,
      filename: message.video.file_name || "video.mp4",
      mimeType: message.video.mime_type || "video/mp4",
    });
  }
  if (message.photo && message.photo.length > 0) {
    const candidate = pickPhotoSize(message.photo);
    if (candidate) {
      files.push({
        fileId: candidate.file_id,
        label: "photo",
        size: candidate.file_size,
        filename: "photo.jpg",
        mimeType: "image/jpeg",
      });
    }
  }

  return files;
}

function pickPhotoSize(sizes: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  const sorted = [...sizes].sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
  for (const size of sorted) {
    if (!size.file_size || size.file_size <= MAX_MEDIA_BYTES) {
      return size;
    }
  }
  return sorted[sorted.length - 1];
}

function forwardOriginPrefix(origin: TelegramForwardOrigin): string | null {
  switch (origin.type) {
    case "user": {
      const user = origin.sender_user;
      if (!user) return "Forwarded from user";
      const name = user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
      return user.username ? `Forwarded from ${name} (@${user.username})` : `Forwarded from ${name}`;
    }
    case "hidden_user":
      return `Forwarded from ${origin.sender_user_name || "Hidden User"}`;
    case "chat": {
      const chat = origin.sender_chat;
      if (!chat) return "Forwarded from chat";
      return chat.username ? `Forwarded from ${chat.title} (@${chat.username})` : `Forwarded from ${chat.title}`;
    }
    case "channel": {
      const channel = origin.chat;
      if (!channel) return "Forwarded from channel";
      return channel.username ? `Forwarded from ${channel.title} (@${channel.username})` : `Forwarded from ${channel.title}`;
    }
    default:
      return null;
  }
}

function formatContent(content: string, entities: TelegramEntity[]): string {
  const supported = new Set(["url", "text_link", "bold", "italic"]);
  const sorted = [...entities]
    .filter((e) => supported.has(e.type))
    .sort((a, b) => (a.offset === b.offset ? a.length - b.length : a.offset - b.offset));

  let result = "";
  let cursor = 0;
  for (const entity of sorted) {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    if (start < cursor) {
      continue;
    }
    if (start >= content.length) {
      break;
    }
    result += content.slice(cursor, start);
    const segment = content.slice(start, end);
    result += applyEntityFormatting(segment, entity);
    cursor = end;
  }
  result += content.slice(cursor);
  return result;
}

function applyEntityFormatting(segment: string, entity: TelegramEntity): string {
  if (!segment.trim()) {
    return segment;
  }
  const match = segment.match(/^(\s*)(.*?)(\s*)$/s);
  if (!match) {
    return segment;
  }
  const [, prefix, core, suffix] = match;
  switch (entity.type) {
    case "url":
      return `${prefix}[${core}](${core})${suffix}`;
    case "text_link":
      return `${prefix}[${core}](${entity.url || core})${suffix}`;
    case "bold":
      return `${prefix}**${core}**${suffix}`;
    case "italic":
      return `${prefix}*${core}*${suffix}`;
    default:
      return segment;
  }
}

async function sendListPage(env: Env, options: { chatId: number; pageToken: string; history: string[]; messageId?: number }): Promise<void> {
  const pageSize = clampPageSize(env.PAGE_SIZE);
  const list = await memosListMemos(env, {
    pageSize,
    pageToken: options.pageToken,
    orderBy: "display_time desc",
  });
  const memos = list.memos || [];
  const text = renderListText(memos);
  const keyboard = buildListKeyboard(memos, {
    token: options.pageToken,
    nextToken: list.nextPageToken || "",
    history: options.history,
  });

  if (options.messageId) {
    await telegramRequest(env, "editMessageText", {
      chat_id: options.chatId,
      message_id: options.messageId,
      text,
      reply_markup: keyboard,
    });
  } else {
    await telegramRequest(env, "sendMessage", {
      chat_id: options.chatId,
      text,
      reply_markup: keyboard,
    });
  }
}

function renderListText(memos: MemosMemo[]): string {
  if (memos.length === 0) {
    return "No memos found.";
  }
  return "请选择一条 memo：";
}

function buildListKeyboard(
  memos: MemosMemo[],
  options: { token: string; nextToken: string; history: string[] }
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  memos.forEach((memo, idx) => {
    const title = memo.snippet?.trim() || memo.content?.split("\n")[0]?.trim() || "(empty)";
    const trimmed = excerpt(title, 10);
    rows.push([
      {
        text: trimmed,
        callback_data: encodeCallback({
          a: "detail",
          memoId: memoIdFromName(memo.name),
        }),
      },
    ]);
  });

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (options.history.length > 0) {
    const prevHistory = options.history.slice(0, -1);
    const prevToken = options.history[options.history.length - 1];
    navRow.push({
      text: "Prev",
      callback_data: encodeCallback({
        a: "list",
        token: prevToken,
        hist: prevHistory,
      }),
    });
  }
  if (options.nextToken) {
    navRow.push({
      text: "Next",
      callback_data: encodeCallback({
        a: "list",
        token: options.nextToken,
        hist: [...options.history, options.token],
      }),
    });
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }

  return { inline_keyboard: rows };
}

async function sendDetail(env: Env, options: { chatId: number; memoName: string }): Promise<void> {
  const memo = await memosGetMemo(env, options.memoName);
  if (shouldShowMedia(env)) {
    const images = getMemoImages(memo);
    if (images.length > 0) {
      const caption = truncateCaption(memo.content || "(empty)");
      await sendMemoMedia(env, options.chatId, memo, caption);
      return;
    }
  }

  const text = renderDetailText(memo);
  await telegramRequest(env, "sendMessage", {
    chat_id: options.chatId,
    text,
  });
}

function renderDetailText(memo: MemosMemo): string {
  const title = memo.content?.split("\n")[0]?.trim() || "(empty)";
  const meta: string[] = [
    memo.pinned ? "📌 Pinned" : "Pinned: false",
    `Visibility: ${memo.visibility || "UNKNOWN"}`,
  ];
  if (memo.tags && memo.tags.length > 0) {
    meta.push(`Tags: ${memo.tags.join(", ")}`);
  }
  if (memo.displayTime) {
    meta.push(`Display: ${memo.displayTime}`);
  }
  if (memo.updateTime) {
    meta.push(`Updated: ${memo.updateTime}`);
  }
  const body = memo.content || "(empty)";
  const text = `${title}\n${meta.join(" | ")}\n\n${body}`;
  return truncateMessage(text);
}

function getMemoImages(memo: MemosMemo): MemosAttachment[] {
  const attachments = memo.attachments || [];
  return attachments.filter((a) => a.externalLink && a.type?.startsWith("image/")).slice(0, MAX_DETAIL_MEDIA);
}

function truncateCaption(text: string): string {
  if (text.length <= MAX_CAPTION_LEN) {
    return text;
  }
  return `${text.slice(0, Math.max(0, MAX_CAPTION_LEN - 3))}...`;
}

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit);
}

async function sendMemoMedia(env: Env, chatId: number, memo: MemosMemo, caption?: string): Promise<void> {
  const images = getMemoImages(memo);
  if (images.length === 0) {
    return;
  }

  const media = images.map((image, index) => {
    if (index === 0 && caption) {
      return { type: "photo", media: image.externalLink, caption };
    }
    return { type: "photo", media: image.externalLink };
  });

  const res = await telegramRequest(env, "sendMediaGroup", {
    chat_id: chatId,
    media,
  });

  if (res?.ok) {
    return;
  }

  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const ok = await telegramRequest(env, "sendPhoto", {
      chat_id: chatId,
      photo: image.externalLink,
      caption: i === 0 ? caption : undefined,
    });
    if (!ok?.ok) {
      await sendMessage(env, chatId, `Image: ${image.externalLink}`);
    }
  }
}

async function updateMemoVisibility(env: Env, memoName: string, visibility: "PUBLIC" | "PROTECTED" | "PRIVATE"): Promise<void> {
  const memo = await memosGetMemo(env, memoName);
  const memoId = memoIdFromName(memoName);
  await memosRequest(env, "PATCH", `/memos/${memoId}?updateMask=visibility`, {
    name: memoName,
    content: memo.content,
    visibility,
  });
}

async function toggleMemoPinned(env: Env, memoName: string): Promise<void> {
  const memo = await memosGetMemo(env, memoName);
  const memoId = memoIdFromName(memoName);
  await memosRequest(env, "PATCH", `/memos/${memoId}?updateMask=pinned`, {
    name: memoName,
    content: memo.content,
    pinned: !memo.pinned,
  });
}

async function memosCreateMemo(env: Env, content: string): Promise<MemosMemo> {
  return memosRequest(env, "POST", "/memos", { content });
}

async function memosCreateAttachment(env: Env, memoName: string, file: { filename: string; type: string; content: Uint8Array }): Promise<void> {
  const payload = {
    filename: file.filename,
    type: file.type,
    content: toBase64(file.content),
    memo: memoName,
  };
  await memosRequest(env, "POST", "/attachments", payload);
}

async function memosListMemos(env: Env, options: { pageSize: number; pageToken: string; orderBy: string }): Promise<MemosListResponse> {
  const params = new URLSearchParams();
  params.set("pageSize", String(options.pageSize));
  params.set("orderBy", options.orderBy);
  if (options.pageToken) {
    params.set("pageToken", options.pageToken);
  }
  return memosRequest(env, "GET", `/memos?${params.toString()}`);
}

async function memosGetMemo(env: Env, memoName: string): Promise<MemosMemo> {
  const memoId = memoIdFromName(memoName);
  return memosRequest(env, "GET", `/memos/${memoId}`);
}

async function memosRequest(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const base = env.MEMOS_BASE_URL.replace(/\/$/, "");
  const url = `${base}/api/v1${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.MEMOS_TOKEN}`,
  };
  let payload: BodyInit | undefined;
  if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: payload,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Memos API error", { method, path, status: res.status, text });
    throw new Error(`Memos API error (${res.status}): ${text}`);
  }
  if (res.status === 204) {
    return {};
  }
  return res.json();
}

async function telegramRequest(env: Env, method: string, body: Record<string, unknown>): Promise<any> {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text };
  }
  return res.json();
}

async function sendMessage(env: Env, chatId: number, text: string): Promise<void> {
  await telegramRequest(env, "sendMessage", { chat_id: chatId, text: truncateMessage(text) });
}

async function answerCallback(env: Env, callbackId: string, text: string): Promise<void> {
  await telegramRequest(env, "answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: false });
}

async function downloadTelegramFile(
  env: Env,
  file: { fileId: string; filename?: string; mimeType?: string }
): Promise<{ filename: string; type: string; content: Uint8Array } | null> {
  const getFile = await telegramRequest(env, "getFile", { file_id: file.fileId });
  if (!getFile?.ok || !getFile.result?.file_path) {
    return null;
  }
  const filePath = getFile.result.file_path as string;
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  const arrayBuffer = await res.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length > MAX_MEDIA_BYTES) {
    return null;
  }
  const contentType = resolveContentType(res.headers.get("content-type"), file.mimeType, bytes);
  return {
    filename: file.filename || filePath.split("/").pop() || "file",
    type: contentType,
    content: bytes,
  };
}

function resolveContentType(headerType: string | null, hintedType: string | undefined, bytes: Uint8Array): string {
  const normalized = (headerType || "").split(";")[0].trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") {
    return normalized;
  }
  if (hintedType && hintedType !== "application/octet-stream") {
    return hintedType;
  }
  const sniffed = sniffImageType(bytes);
  if (sniffed) {
    return sniffed;
  }
  return "application/octet-stream";
}

function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

async function maybeSkipLargeFile(
  env: Env,
  chatId: number,
  file: { label: string; size?: number }
): Promise<boolean> {
  if (file.size && file.size > MAX_MEDIA_BYTES) {
    await sendMessage(env, chatId, `${file.label} is larger than 20MB and was skipped.`);
    return true;
  }
  return false;
}

function memoIdFromName(name: string): string {
  if (!name) {
    return "";
  }
  if (name.startsWith("memos/")) {
    return name.slice("memos/".length);
  }
  return name;
}

function memoNameFromId(id: string): string {
  if (!id) {
    return "";
  }
  if (id.startsWith("memos/")) {
    return id;
  }
  return `memos/${id}`;
}

function memoLink(env: Env, memoName: string): string {
  const base = env.MEMOS_BASE_URL.replace(/\/$/, "");
  const id = memoIdFromName(memoName);
  return id ? `${base}/memos/${id}` : base;
}

function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LEN) {
    return text;
  }
  return `${text.slice(0, MAX_MESSAGE_LEN - 3)}...`;
}

function clampPageSize(value?: string): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 20) {
    return parsed;
  }
  return 8;
}

function shouldShowMedia(env: Env): boolean {
  if (!env.SHOW_MEDIA) return false;
  return env.SHOW_MEDIA === "1" || env.SHOW_MEDIA.toLowerCase() === "true";
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function encodeCallback(payload: CallbackPayload): string {
  const json = JSON.stringify(payload);
  const encoded = base64Encode(json);
  if (encoded.length <= 64) {
    return encoded;
  }

  if ("hist" in payload && payload.hist && payload.hist.length > 0) {
    const trimmed = { ...payload, hist: [] };
    const trimmedEncoded = base64Encode(JSON.stringify(trimmed));
    if (trimmedEncoded.length <= 64) {
      return trimmedEncoded;
    }
  }

  return base64Encode(JSON.stringify({ a: payload.a }));
}

function decodeCallback(data: string): CallbackPayload | null {
  try {
    const json = base64Decode(data);
    return JSON.parse(json) as CallbackPayload;
  } catch {
    return null;
  }
}

function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Decode(input: string): string {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
