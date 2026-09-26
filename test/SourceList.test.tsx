import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceList } from "../src/components/SourceList.js";
import type { DraftSource } from "../src/api/types.js";

/*
 * #66 AC3: asking a duo about a shared file puts the attachment in the
 * answer's sources, so provenance stays honest. The daemon owns the
 * attachment source (digital-duo #190: kind "attachment", id the
 * workspace's own file reference, label the filename, type and a preview);
 * this client renders what it is told and adds nothing — its part is to
 * mirror the kind faithfully and let the provenance rail show the row.
 */
describe("the provenance rail carries an attachment beside the corpus's own sources", () => {
  const sources: DraftSource[] = [
    { kind: "attachment", id: "mxc://workspace.example/policy1", label: "attachment notes.txt (text/plain): Refunds within 30 days" },
    { kind: "evidence", id: "ev-1", label: "past exchange (similarity 0.81): refund policy" },
  ];

  it("counts the attachment as a source and lists its label as the daemon wrote it", () => {
    render(<SourceList sources={sources} />);
    expect(screen.getByText("Drew on 2 sources")).toBeInTheDocument();
    expect(screen.getByText("attachment notes.txt (text/plain): Refunds within 30 days")).toBeInTheDocument();
    expect(screen.getByText("past exchange (similarity 0.81): refund policy")).toBeInTheDocument();
  });

  it("an attachment and evidence that share an id are still two rows", () => {
    render(
      <SourceList
        sources={[
          { kind: "attachment", id: "same", label: "attachment a.txt (text/plain): a" },
          { kind: "evidence", id: "same", label: "past exchange (similarity 0.50): b" },
        ]}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
