import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SkillStep } from "@/components/chat/skill-step";
import { MessageContent } from "@/components/chat/message-content";
import { LOAD_SKILL_TOOL_NAME, READ_SKILL_ASSET_TOOL_NAME } from "@/contracts/skills";

describe("SkillStep — reference 'Skill' step (skill-loading-step.md)", () => {
  it("renders the 'Skill' label with a completed status and duration", () => {
    const { container } = render(<SkillStep status="COMPLETED" durationMs={4600} />);
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(screen.getByText("4.6s")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
  });

  it("renders a spinner and no duration while running", () => {
    const { container } = render(<SkillStep status="RUNNING" />);
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByText(/s$/)).not.toBeInTheDocument();
  });

  it("does NOT render an expand/disclosure control (no <details>/<summary>, no chevron) — the reference row has none", () => {
    const { container } = render(<SkillStep status="COMPLETED" durationMs={5200} />);
    expect(container.querySelector("details")).not.toBeInTheDocument();
    expect(container.querySelector("summary")).not.toBeInTheDocument();
    // No chevron icon and no clickable/button affordance on the row itself.
    expect(container.querySelector("button")).not.toBeInTheDocument();
  });

  it("does NOT render a content/skill-name preview beyond the literal 'Skill' label", () => {
    render(<SkillStep status="COMPLETED" durationMs={1000} />);
    // The reference never surfaces a specific skill's name on the step
    // itself — only the generic word "Skill".
    expect(screen.queryByText(/crop-image-skill|model-recommendations/i)).not.toBeInTheDocument();
  });
});

describe("MessageContent — load_skill/read_skill_asset tool blocks render as a SkillStep, not a ToolCard", () => {
  it("renders load_skill as a 'Skill' step with no card chrome (no <details>, no 'Tool' row, no credits)", () => {
    const { container } = render(
      <MessageContent
        blocks={[
          { type: "tool_use", id: "call_1", name: LOAD_SKILL_TOOL_NAME, input: { skillName: "crop-image" } },
          {
            type: "tool_result",
            toolUseId: "call_1",
            output: {},
            name: LOAD_SKILL_TOOL_NAME,
            status: "COMPLETED",
            durationMs: 4600,
          },
          { type: "text", text: "Done." },
        ]}
      />,
    );
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(screen.getByText("4.6s")).toBeInTheDocument();
    // Exactly one <details> — the outer StepGroup — no nested ToolCard
    // <details> for this step.
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(screen.queryByText("Tool")).not.toBeInTheDocument();
    expect(screen.queryByText("crop-image")).not.toBeInTheDocument();
  });

  it("renders read_skill_asset as a 'Skill' step too", () => {
    render(
      <MessageContent
        blocks={[
          {
            type: "tool_result",
            toolUseId: "call_2",
            output: {},
            name: READ_SKILL_ASSET_TOOL_NAME,
            status: "COMPLETED",
            durationMs: 800,
          },
          { type: "text", text: "Done." },
        ]}
      />,
    );
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(screen.getByText("800ms")).toBeInTheDocument();
  });

  it("a pending load_skill tool_use (no result yet) renders as a running Skill step", () => {
    const { container } = render(
      <MessageContent blocks={[{ type: "tool_use", id: "call_3", name: LOAD_SKILL_TOOL_NAME, input: {} }]} />,
    );
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });
});
