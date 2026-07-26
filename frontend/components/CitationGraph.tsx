"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as d3 from "d3";

interface Neighbor { id: string; title: string; pagerank?: number; year?: string; dir?: "center"|"out"|"in" }
interface Edge { source: string; target: string }
interface GraphResp { nodes: Neighbor[]; edges: Edge[] }

/**
 * Citation neighborhood viz (spec §8).
 * - Zoom/pan via d3.zoom on an inner <g> container
 * - Collision force prevents node overlap
 * - Year labels always; title labels appear at zoom > 1.4
 * - Filter checkboxes toggle node+edge visibility without restarting simulation
 * - Click non-center node → navigate to that document
 */
export function CitationGraph({ initialGraphData }: { initialGraphData: GraphResp | null }) {
  const svgRef      = useRef<SVGSVGElement | null>(null);
  const zoomRef     = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // Refs let the filter effect reach into the live D3 selections without
  // restarting the simulation every time a checkbox changes.
  const linkSelRef  = useRef<d3.Selection<SVGLineElement, any, SVGGElement, unknown> | null>(null);
  const nodeSelRef  = useRef<d3.Selection<SVGCircleElement, any, SVGGElement, unknown> | null>(null);
  const dirOfRef    = useRef<Map<string, string>>(new Map());
  const yearLblRef  = useRef<d3.Selection<SVGTextElement, any, SVGGElement, unknown> | null>(null);
  const titleLblRef = useRef<d3.Selection<SVGTextElement, any, SVGGElement, unknown> | null>(null);
  // Shared state for zoom handler (defined once) and filter effect (runs on checkbox change).
  const filterRef   = useRef({ showOut: true, showIn: true, showCross: true });
  const zoomKRef    = useRef(1);

  const [graph]     = useState<GraphResp | null>(initialGraphData);
  const [hovered, setHovered]     = useState<string | null>(null);
  const [showOut,   setShowOut]   = useState(true);
  const [showIn,    setShowIn]    = useState(true);
  const [showCross, setShowCross] = useState(true);
  const router = useRouter();

  // ── Main D3 setup — runs once per graph ──────────────────────────────────
  useEffect(() => {
    if (!graph || !svgRef.current) return;
    const width = 720, height = 420;
    const svg = d3.select(svgRef.current).attr("viewBox", `0 0 ${width} ${height}`);
    svg.selectAll("*").remove();

    // Arrow marker lives outside the zoom container so its size stays fixed
    svg.append("defs").append("marker")
      .attr("id", "cg-arrow").attr("viewBox", "0 -5 10 10")
      .attr("refX", 15).attr("refY", 0).attr("markerWidth", 5).attr("markerHeight", 5)
      .attr("orient", "auto")
      .append("path").attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "hsl(var(--muted))").attr("opacity", 0.5);

    // All graph elements live inside this group; the zoom transform is applied here
    const container = svg.append("g");

    const dirOf = new Map(graph.nodes.map(n => [n.id, n.dir ?? "out"]));
    dirOfRef.current = dirOf;

    const nodes = graph.nodes.map(n => ({ ...n })) as any[];
    const links = graph.edges.map(e => ({ source: e.source, target: e.target })) as any[];

    const nodeRadius = (d: any) => 4 + Math.min(8, Math.log1p((d.pagerank ?? 0) * 10000) * 2);

    const sim = d3.forceSimulation(nodes)
      .force("link",    d3.forceLink(links).id((d: any) => d.id).distance(80))
      .force("charge",  d3.forceManyBody().strength(-250))
      .force("center",  d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide<any>().radius(d => nodeRadius(d) + 5));

    // Links
    const linkG = container.append("g")
      .attr("stroke", "hsl(var(--muted))").attr("opacity", 0.45);
    const link = linkG.selectAll<SVGLineElement, any>("line")
      .data(links).join("line")
      .attr("marker-end", "url(#cg-arrow)");
    linkSelRef.current = link;

    // Nodes
    const nodeColor = (d: any): string => {
      if (d.dir === "center") return "hsl(var(--accent))";
      if (d.dir === "in")     return "hsl(var(--rcr))";
      return "hsl(var(--coi))";
    };
    const nodeG = container.append("g");
    const node = nodeG.selectAll<SVGCircleElement, any>("circle")
      .data(nodes).join("circle")
      .attr("r", nodeRadius)
      .attr("fill", nodeColor)
      .attr("stroke", "white").attr("stroke-width", 1)
      .style("cursor", (d: any) => d.dir === "center" ? "default" : "pointer")
      .on("click", (_evt: any, d: any) => {
        if (d.dir !== "center") router.push(`/document?id=${encodeURIComponent(d.id)}` as any);
      })
      .on("mouseover", (_evt: any, d: any) => setHovered(d.title || d.id))
      .on("mouseout",  () => setHovered(null))
      .call(d3.drag<SVGCircleElement, any>()
        .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end",   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }) as any);

    node.append("title").text((d: any) => d.title || d.id);
    nodeSelRef.current = node;

    // Labels — year always, title only at zoom > 1.4
    const labelG = container.append("g")
      .attr("pointer-events", "none")
      .attr("fill", "hsl(var(--muted))");

    const yearLbl = labelG.selectAll<SVGTextElement, any>("text.yr")
      .data(nodes.filter((n: any) => n.year)).join("text")
      .attr("class", "yr").attr("font-size", 9)
      .text((d: any) => d.year);
    yearLblRef.current = yearLbl;

    const titleLbl = labelG.selectAll<SVGTextElement, any>("text.tl")
      .data(nodes).join("text")
      .attr("class", "tl").attr("font-size", 8)
      .style("display", "none")
      .text((d: any) => (d.title || d.id).slice(0, 45));
    titleLblRef.current = titleLbl;

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 10])
      .on("zoom", event => {
        container.attr("transform", event.transform);
        const k = event.transform.k;
        zoomKRef.current = k;
        const { showOut, showIn } = filterRef.current;
        const nodeHidden = (d: any) =>
          (d.dir === "out" && !showOut) || (d.dir === "in" && !showIn);
        yearLbl.style("display",  (d: any) => nodeHidden(d) ? "none" : (k > 1.4 ? "none" : null as any));
        titleLbl.style("display", (d: any) => nodeHidden(d) ? "none" : (k > 1.4 ? null as any : "none"));
      });
    svg.call(zoom).on("dblclick.zoom", null); // disable dblclick zoom
    zoomRef.current = zoom;

    sim.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x).attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x).attr("y2", (d: any) => d.target.y);
      node.attr("cx", (d: any) => d.x).attr("cy", (d: any) => d.y);
      yearLbl .attr("x", (d: any) => (d.x ?? 0) + 8).attr("y", (d: any) => (d.y ?? 0) + 3);
      titleLbl.attr("x", (d: any) => (d.x ?? 0) + 8).attr("y", (d: any) => (d.y ?? 0) + 3);
    });

    return () => { sim.stop(); };
  }, [graph, router]);

  // ── Filter effect — shows/hides edges+nodes without restarting simulation ──
  useEffect(() => {
    // Keep filterRef in sync so the zoom handler (defined once) always reads
    // current state when it re-applies label visibility on zoom events.
    filterRef.current = { showOut, showIn, showCross };

    const link     = linkSelRef.current;
    const node     = nodeSelRef.current;
    const yearLbl  = yearLblRef.current;
    const titleLbl = titleLblRef.current;
    const dirOf    = dirOfRef.current;
    if (!link || !node) return;

    link.style("display", (e: any) => {
      const srcId  = typeof e.source === "object" ? e.source.id : e.source;
      const tgtId  = typeof e.target === "object" ? e.target.id : e.target;
      const srcDir = dirOf.get(srcId) ?? "out";
      const tgtDir = dirOf.get(tgtId) ?? "out";
      if (srcDir === "center") return showOut   ? null : "none"; // center→out
      if (tgtDir === "center") return showIn    ? null : "none"; // in→center
      return                          showCross ? null : "none"; // out→out
    });

    // Hide nodes whose edge type is fully toggled off.
    const nodeViz = (d: any): string | null =>
      d.dir === "out" ? (showOut ? null : "none") :
      d.dir === "in"  ? (showIn  ? null : "none") : null;

    node.style("display", nodeViz);

    // Sync labels. For year labels, restore zoom-based visibility for visible
    // nodes; for title labels, preserve "hidden until zoom>1.4" default.
    const k = zoomKRef.current;
    yearLbl?.style("display",  (d: any) => nodeViz(d) === "none" ? "none" : (k > 1.4 ? "none" : null as any));
    titleLbl?.style("display", (d: any) => nodeViz(d) === "none" ? "none" : (k > 1.4 ? null as any : "none"));
  }, [showOut, showIn, showCross]);

  const handleReset = () => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current)
      .transition().duration(350)
      .call(zoomRef.current.transform, d3.zoomIdentity);
  };

  if (!graph) {
    return (
      <p className="text-sm text-[hsl(var(--muted))]">
        Citation graph unavailable — this document may not yet be indexed in the graph database.
      </p>
    );
  }

  return (
    <figure
      aria-label={`Citation graph for ${initialGraphData?.nodes?.[0]?.id || "document"}`}
      className="border rounded overflow-hidden"
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-xs border-b text-[hsl(var(--muted))]">
        <button
          onClick={handleReset}
          className="px-2 py-0.5 rounded border border-[hsl(var(--accent)/0.4)] text-[hsl(var(--accent))] hover:bg-[hsl(var(--accent)/0.08)] transition-colors"
        >
          Reset view
        </button>
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input type="checkbox" checked={showOut} onChange={e => setShowOut(e.target.checked)} />
          <span className="inline-block w-2 h-2 rounded-full bg-[hsl(var(--coi))]" aria-hidden="true" />
          Cites ({graph.edges.filter(e => (initialGraphData?.nodes.find(n => n.id === e.source)?.dir ?? "out") === "center").length})
        </label>
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input type="checkbox" checked={showIn} onChange={e => setShowIn(e.target.checked)} />
          <span className="inline-block w-2 h-2 rounded-full bg-[hsl(var(--rcr))]" aria-hidden="true" />
          Cited by ({graph.nodes.filter(n => n.dir === "in").length})
        </label>
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input type="checkbox" checked={showCross} onChange={e => setShowCross(e.target.checked)} />
          Cross-links ({graph.edges.filter(e => {
            const sd = initialGraphData?.nodes.find(n => n.id === e.source)?.dir ?? "out";
            const td = initialGraphData?.nodes.find(n => n.id === e.target)?.dir ?? "out";
            return sd !== "center" && td !== "center";
          }).length})
        </label>
        <span className="ml-auto">{graph.nodes.length} nodes · {graph.edges.length} edges</span>
      </div>

      {/* Graph canvas */}
      <svg
        ref={svgRef}
        role="img"
        className="w-full h-auto"
        style={{ touchAction: "none" }}
      />

      {/* Hover title strip */}
      {hovered && (
        <p
          className="px-2 py-1 text-xs text-[hsl(var(--muted))] border-t truncate"
          title={hovered}
        >
          {hovered}
        </p>
      )}

      {/* Legend + hint */}
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-1 text-xs text-[hsl(var(--muted))] border-t">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-[hsl(var(--accent))]" aria-hidden="true" />
          This paper
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-[hsl(var(--coi))]" aria-hidden="true" />
          Cites
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-[hsl(var(--rcr))]" aria-hidden="true" />
          Cited by
        </span>
        <span className="ml-auto text-[10px]">
          Scroll to zoom · drag canvas to pan · click node to open
        </span>
      </figcaption>
    </figure>
  );
}
