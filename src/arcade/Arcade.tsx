/**
 * The arcade root: the whole router.
 *
 * `/` is the floor, `/<id>` is a cabinet. Deliberately about thirty lines
 * rather than a routing dependency — there are two routes, and a library here
 * would be more configuration than code.
 */
import { Suspense, useCallback, useEffect, useState } from "react";
import { ArcadeProvider } from "./ArcadeProvider";
import Hub from "./Hub";
import { cabinetById } from "./games";

function pathOf() {
  return location.pathname.replace(/\/+$/, "") || "/";
}

export default function Arcade() {
  const [path, setPath] = useState(pathOf);

  // Browser back/forward has to work — a player who hits back from a cabinet
  // expects the floor, not a blank page.
  useEffect(() => {
    const onPop = () => setPath(pathOf());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((to: string) => {
    if (to === pathOf()) return;
    history.pushState(null, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);

  const cab = path === "/" ? null : cabinetById(path.slice(1));

  return (
    <ArcadeProvider>
      {cab?.Game ? (
        <Suspense fallback={<Booting name={cab.name} />}>
          <cab.Game />
        </Suspense>
      ) : path === "/" ? (
        <Hub go={go} />
      ) : (
        <NotFound go={go} />
      )}
    </ArcadeProvider>
  );
}

function Booting({ name }: { name: string }) {
  return (
    <div className="cx-boot">
      <span className="cx-blink">LOADING</span>
      <p>{name}</p>
    </div>
  );
}

function NotFound({ go }: { go: (p: string) => void }) {
  return (
    <div className="cx-boot">
      <span className="cx-blink">NO SUCH CABINET</span>
      <p>Nothing is plugged in at this address.</p>
      <button className="cx-btn primary" onClick={() => go("/")}>
        Back to the floor
      </button>
    </div>
  );
}
