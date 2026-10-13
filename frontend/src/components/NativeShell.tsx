import { useEffect, useState, type ReactNode } from "react";

/** Presentation state stays in memory; it does not alter action authority. */
export default function NativeShell({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<"dark" | "light">("dark");
  useEffect(() => {
    document.documentElement.dataset.surface = appearance;
    document.documentElement.classList.toggle("dark", appearance === "dark");
  }, [appearance]);

  return (
    <>
      <a className="kanchay-skip" data-szl-holo-skip href="#main-content">Skip to evidence</a>
      <header className="immune-native-header">
        <div className="immune-native-bar">
          <a className="immune-native-brand" href={import.meta.env.BASE_URL} aria-label="IMMUNE workspace">
            <img src={`${import.meta.env.BASE_URL}assets/szl/szl-icon-32.svg`} width="40" height="40" alt="" />
            <span><span className="immune-parent">SZL Holdings</span><strong>IMMUNE</strong></span>
          </a>
          <nav aria-label="Explore IMMUNE">
            <a href={`${import.meta.env.BASE_URL}#main-content`}>Workspace</a>
            <a href={`${import.meta.env.BASE_URL}#proof-boundary-title`}>Evidence</a>
            <a href={`${import.meta.env.BASE_URL}#developer-quickstart`}>Developers</a>
            <a href="https://github.com/szl-holdings/immune">Source</a>
          </nav>
          <button className="immune-appearance" type="button" onClick={() => setAppearance(appearance === "dark" ? "light" : "dark")} aria-label={`Use ${appearance === "dark" ? "light" : "dark"} appearance`}>
            <span aria-hidden="true">◐</span><span className="immune-appearance-label">{appearance === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
      </header>
      {children}
      <footer className="immune-native-footer">
        <div><strong>IMMUNE · SZL Holdings</strong><p>Source, observation and action authority remain separate.</p></div>
        <nav aria-label="SZL ecosystem">
          <a href="https://a-11-oy.com">Product</a><a href="https://a11oy.net">Proof</a>
          <a href="https://huggingface.co/spaces/SZLHOLDINGS/immune-lattice">Python observer</a>
          <a href={`${import.meta.env.BASE_URL}assets/szl/PROJECTION.json`}>Design source</a>
        </nav>
        <p className="immune-attribution">Native Orbit artwork © SZL Holdings, CC BY 4.0 · code Apache-2.0 · <a href="https://orcid.org/0009-0001-0110-4173">Stephen Lutar</a></p>
      </footer>
    </>
  );
}
