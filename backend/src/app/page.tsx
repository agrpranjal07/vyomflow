/**
 * This app is a REST API layer only — its Route Handlers under
 * src/app/api/v1/** are the product. This page exists solely so an operator
 * hitting the root URL sees something meaningful instead of a 404.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h1>VyomFlow backend</h1>
      <p>REST API — see /api/v1/*.</p>
    </main>
  );
}
