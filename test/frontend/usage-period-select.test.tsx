import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UsagePeriodSelect } from "@/components/chat/usage/usage-period-select";

// /usage page's period filter (2026-08-29 — "give an option to select and
// change period"). Plain presentational component, no hooks — no mocking
// needed, same as its own file header describes.
describe("UsagePeriodSelect", () => {
  it("renders the 4 expected option labels", () => {
    render(<UsagePeriodSelect value="all" onChange={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: "Select period" });
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["Last 7 days", "Last 30 days", "Last 90 days", "All time"]);
  });

  it("reflects the current value prop", () => {
    render(<UsagePeriodSelect value="30d" onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Select period" })).toHaveValue("30d");
  });

  it("calls onChange with the corresponding UsagePeriod value when changed", () => {
    const onChange = vi.fn();
    render(<UsagePeriodSelect value="all" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Select period" }), { target: { value: "90d" } });
    expect(onChange).toHaveBeenCalledWith("90d");
  });
});
