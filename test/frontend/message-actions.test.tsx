import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageActions } from "@/components/chat/message-actions";

// A same-day timestamp must be built relative to the real clock (not a
// fixed literal) so the test keeps passing regardless of when it runs — the
// component's day-boundary logic (message-actions.tsx) genuinely depends on
// "now".
const todayIso = new Date().toISOString();
const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

describe("MessageActions", () => {
  it("disables the unimplemented Branch/Good/Bad affordances", () => {
    render(<MessageActions text="hello" createdAt={todayIso} />);
    expect(screen.getByLabelText("Branch from here")).toBeDisabled();
    expect(screen.getByLabelText("Good response")).toBeDisabled();
    expect(screen.getByLabelText("Bad response")).toBeDisabled();
    expect(screen.getByLabelText("Copy message")).not.toBeDisabled();
  });

  it("renders a bare time for a message from today", async () => {
    render(<MessageActions text="hello" createdAt={todayIso} />);
    expect(await screen.findByText(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)).toBeInTheDocument();
  });

  it("renders a bare date, not a time, for a message from an earlier day", async () => {
    render(<MessageActions text="hello" createdAt={yesterdayIso} />);
    expect(await screen.findByText(/^[A-Z][a-z]{2} \d{1,2}$/)).toBeInTheDocument();
    expect(screen.queryByText(/\d{1,2}:\d{2}\s?(AM|PM)/i)).not.toBeInTheDocument();
  });
});
