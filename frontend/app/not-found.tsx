import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-12 text-center">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-2 text-[hsl(var(--muted))]">The page or document you requested doesn’t exist.</p>
      <p className="mt-6"><Link className="underline" href="/">Back to search</Link></p>
    </div>
  );
}
