import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessageList } from "@/components/chat/message-list";
import { useMessagesList } from "@/hooks/use-messages";
import type { MessageDTO } from "@/contracts/messages";
import type { AttachmentDTO } from "@/contracts/attachments";
import type { AgentRunDTO } from "@/contracts/runs";

// useMessagesList hits the real API client via react-query — stub it directly
// so this test exercises MessageList's own scroll/resize behavior in
// isolation, not the fetch layer (already covered elsewhere). A `vi.fn` (not
// a plain arrow function) so individual tests can override its return value
// via `vi.mocked(useMessagesList).mockReturnValue(...)`.
vi.mock("@/hooks/use-messages", () => ({
  useMessagesList: vi.fn(() => ({
    data: { pages: [{ items: [] }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  })),
}));

// @tanstack/react-virtual measures the scroll container via
// offsetWidth/offsetHeight (virtual-core's elementScroll.ts) to compute
// which rows are in view. jsdom elements report 0 for both by default, so
// without this every row would be considered outside the viewport and
// getVirtualItems() would return an empty list — these tests would see no
// message content at all. A fixed non-zero size is enough for the small
// fixture lists used here to render in full.
let restoreOffsetSize: (() => void) | null = null;
function stubOffsetSize() {
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  restoreOffsetSize = () => {
    if (heightDesc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightDesc);
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDesc);
  };
}

const todayIso = new Date().toISOString();

function makeMessage(overrides: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: "m-user",
    chatId: "chat-1",
    role: "user",
    content: [{ type: "text", text: "hello" }],
    attachments: [],
    status: "complete",
    createdAt: todayIso,
    ...overrides,
  };
}

// jsdom has no ResizeObserver implementation. No existing polyfill/mock
// pattern exists elsewhere in this workspace (checked test/support and
// other frontend/*.test.tsx files) — this is the first component to need
// one, so a minimal capturing stub is defined here: it records the latest
// callback so a test can invoke it manually to simulate a height change.
let resizeCallback: ((...args: unknown[]) => void) | null = null;

class MockResizeObserver {
  constructor(cb: (...args: unknown[]) => void) {
    resizeCallback = cb;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function makeAttachment(overrides: Partial<AttachmentDTO> = {}): AttachmentDTO {
  return {
    id: "att-1",
    chatId: "chat-1",
    messageId: "m-user",
    orderIndex: 0,
    status: "READY",
    mimeType: "image/png",
    byteSize: 100,
    fileName: "photo.png",
    resultUrl: "https://example.com/photo.png",
    errorCode: null,
    errorMessage: null,
    createdAt: todayIso,
    updatedAt: todayIso,
    ...overrides,
  };
}

function setMessages(items: MessageDTO[]) {
  vi.mocked(useMessagesList).mockReturnValue({
    data: { pages: [{ items }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function renderMessageList(props: Partial<ComponentProps<typeof MessageList>> = {}) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MessageList chatId="chat-1" {...props} />
    </QueryClientProvider>,
  );
}

describe("MessageList auto-scroll", () => {
  beforeEach(() => {
    resizeCallback = null;
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    // jsdom doesn't implement scrollIntoView — stub it so we can assert calls.
    Element.prototype.scrollIntoView = vi.fn();
    stubOffsetSize();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetSize?.();
  });

  it("scrolls to bottom on a ResizeObserver-driven height increase while near the bottom", () => {
    renderMessageList();
    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    scrollSpy.mockClear();

    expect(resizeCallback).not.toBeNull();
    act(() => {
      resizeCallback?.();
    });

    expect(scrollSpy).toHaveBeenCalledWith({ block: "end" });
  });

  it("does not scroll on a height increase after the user has scrolled up", () => {
    renderMessageList();
    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;

    // Simulate the user scrolling away from the bottom: the outer scroll
    // container's onScroll handler reads scrollHeight/scrollTop/clientHeight
    // directly off the DOM node, so stub those to look "scrolled up". The
    // outer container is identified by the `scrollbar-thin` class it carries
    // (Part 3 — it's the element that actually scrolls).
    const container = document.querySelector(".scrollbar-thin") as HTMLElement;
    Object.defineProperty(container, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(container, "scrollTop", { value: 0, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 500, configurable: true });
    fireEvent.scroll(container);

    scrollSpy.mockClear();

    act(() => {
      resizeCallback?.();
    });

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

// T36 (§9.5 Group A) — retry() re-sends the original user turn as a new run.
// MessageList constructs the onRetry closure passed to MessageBubble from
// the failed/cancelled assistant message's *preceding* user message
// (message-list.tsx:158-171); page.tsx's handleRetry (the real onRetry prop
// in production) forwards that exact (text, attachmentIds) pair into
// sendTurn.mutateAsync and then starts a new run from the response
// (page.tsx:101-108). This harness mirrors handleRetry's real logic rather
// than mounting the full ChatPage (which needs Clerk/router/query-hook
// mocking well beyond this component's own concerns) — same pattern as
// chat-switch-state-reset.test.tsx's Composer harness.
describe("MessageList — retry re-sends the original turn as a new run (T36)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    Element.prototype.scrollIntoView = vi.fn();
    stubOffsetSize();
  });

  afterEach(() => {
    vi.mocked(useMessagesList).mockReset();
    vi.unstubAllGlobals();
    restoreOffsetSize?.();
  });

  it("clicking Retry on a failed assistant message sends the preceding user message's exact text and attachment ids, then starts a new run from the response", async () => {
    const user = userEvent.setup();
    const originalUserMessage = makeMessage({
      id: "m-user",
      role: "user",
      content: [{ type: "text", text: "original message text" }],
      attachments: [makeAttachment({ id: "att-1" }), makeAttachment({ id: "att-2" })],
    });
    const failedAssistantMessage = makeMessage({
      id: "m-assistant",
      role: "assistant",
      content: [{ type: "text", text: "partial reply" }],
      status: "failed",
    });
    // setMessages feeds data.pages[0].items directly, and MessageList
    // reverses that array to render oldest-to-newest (mirroring the real
    // API's newest-first page order) — so the newer (assistant) message
    // goes first here for the user message to render first on screen.
    setMessages([failedAssistantMessage, originalUserMessage]);

    const runResponse = { run: { id: "run-2" } as AgentRunDTO, realtime: { runId: "run-2" } };
    const sendTurnMutateAsync = vi.fn().mockResolvedValue(runResponse);
    const activeRunStart = vi.fn();

    // Mirrors page.tsx's handleRetry exactly (S6 §7.7): a *new* turn with the
    // original content, not a resume of the dead run.
    async function handleRetry(text: string, attachmentIds: string[]) {
      const response = await sendTurnMutateAsync({ text, attachmentIds });
      activeRunStart(response.run, response.realtime);
    }

    renderMessageList({ onRetry: handleRetry });

    const retryButton = screen.getByRole("button", { name: "Retry" });
    await user.click(retryButton);

    expect(sendTurnMutateAsync).toHaveBeenCalledWith({
      text: "original message text",
      attachmentIds: ["att-1", "att-2"],
    });
    expect(activeRunStart).toHaveBeenCalledWith(runResponse.run, runResponse.realtime);
  });

  it("does not render a Retry affordance when no onRetry handler is wired", () => {
    setMessages([
      makeMessage({ id: "m-assistant", role: "assistant", status: "failed" }),
      makeMessage({ id: "m-user", role: "user" }),
    ]);
    renderMessageList({ onRetry: undefined });
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

// T38 (§9.5 Group A) — a run-level error is *rendered* in the message list
// after finalize, not just held in use-active-run's `lastRunError` state.
// MessageList maps lastRunError onto the matching assistant message's
// errorMessage prop (message-list.tsx:166), which MessageBubble renders as
// visible text for a failed/cancelled assistant message
// (message-bubble.tsx:69,88). use-active-run.test.tsx already asserts the
// *state* shape; this asserts the text actually reaches the DOM.
describe("MessageList — run-level error is rendered after finalize (T38)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    Element.prototype.scrollIntoView = vi.fn();
    stubOffsetSize();
  });

  afterEach(() => {
    vi.mocked(useMessagesList).mockReset();
    vi.unstubAllGlobals();
    restoreOffsetSize?.();
  });

  it("renders lastRunError's errorMessage on the failed assistant message it belongs to", () => {
    setMessages([
      makeMessage({ id: "m-assistant", role: "assistant", status: "failed" }),
      makeMessage({ id: "m-user", role: "user" }),
    ]);

    renderMessageList({
      lastRunError: { assistantMessageId: "m-assistant", errorCode: "upstream_error", errorMessage: "The model timed out" },
    });

    expect(screen.getByText("The model timed out")).toBeInTheDocument();
  });

  it("renders lastRunError's errorMessage on a cancelled assistant message it belongs to", () => {
    setMessages([
      makeMessage({ id: "m-assistant", role: "assistant", status: "cancelled" }),
      makeMessage({ id: "m-user", role: "user" }),
    ]);

    renderMessageList({
      lastRunError: { assistantMessageId: "m-assistant", errorCode: null, errorMessage: "Stopped by another tab" },
    });

    expect(screen.getByText("Stopped by another tab")).toBeInTheDocument();
  });

  it("does not attribute lastRunError's text to an unrelated failed assistant message (falls back to the default copy instead)", () => {
    setMessages([
      makeMessage({ id: "m-assistant", role: "assistant", status: "failed" }),
      makeMessage({ id: "m-user", role: "user" }),
    ]);

    renderMessageList({
      // Belongs to a different (e.g. prior, no-longer-active) run's message.
      lastRunError: { assistantMessageId: "some-other-message", errorCode: "boom", errorMessage: "Wrong turn's error" },
    });

    expect(screen.queryByText("Wrong turn's error")).not.toBeInTheDocument();
    expect(screen.getByText("Response failed — the partial text above was preserved")).toBeInTheDocument();
  });
});
