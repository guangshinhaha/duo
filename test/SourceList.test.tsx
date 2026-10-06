import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceList } from "../src/components/SourceList.js";
import type { DraftSource } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

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

  it("with no api, renders no Remove control at all — a read-only mount, e.g. the share path", () => {
    render(<SourceList sources={sources} />);
    expect(screen.queryByTestId("source-remove")).toBeNull();
  });
});

/*
 * duo#272: the owner removing a bad source inline, from wherever SourceList
 * renders it. A rule source rejects through the same route the Rules tab's
 * own Reject button calls; an evidence source excludes through the
 * daemon's `POST /knowledge/evidence/:recordId/exclude` (digital-duo#288).
 * An attachment names nothing persisted, so it gets no Remove at all.
 */
describe("SourceList — removing a bad source inline (duo#272)", () => {
  const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };
  const sources: DraftSource[] = [
    { kind: "rule", id: "r1", label: "Deploy access: point to the runbook" },
    { kind: "evidence", id: "e1", label: "past exchange (similarity 0.81): refund policy" },
    { kind: "attachment", id: "mxc://workspace.example/file1", label: "attachment notes.txt (text/plain): a" },
  ];

  function renderWithClient(ui: React.ReactElement) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers Remove for a rule and an evidence source, but not for an attachment", () => {
    renderWithClient(<SourceList api={api} sources={sources} />);
    expect(screen.getAllByTestId("source-remove")).toHaveLength(2);
  });

  it("rejects a rule source through the Rules tab's own route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "r1" }), { status: 200 })));
    renderWithClient(<SourceList api={api} sources={[sources[0]!]} />);
    fireEvent.click(screen.getByTestId("source-remove"));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://test/mirror/rules/r1/reject", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByTestId("source-removed")).toHaveTextContent("Removed");
  });

  it("excludes an evidence source through the daemon's new exclude route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ excluded: true }), { status: 200 })));
    renderWithClient(<SourceList api={api} sources={[sources[1]!]} />);
    fireEvent.click(screen.getByTestId("source-remove"));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://test/knowledge/evidence/e1/exclude", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByTestId("source-removed")).toHaveTextContent("Removed");
  });

  it("a refused removal leaves the row in place with the daemon's own error, not a silent no-op", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "Missing bearer token." } }), { status: 401 })),
    );
    renderWithClient(<SourceList api={api} sources={[sources[1]!]} />);
    fireEvent.click(screen.getByTestId("source-remove"));
    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent("Missing bearer token."));
    expect(screen.queryByTestId("source-removed")).toBeNull();
    expect(screen.getByTestId("source-remove")).toBeInTheDocument();
  });
});
