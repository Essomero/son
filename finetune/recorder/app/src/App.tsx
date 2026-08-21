import { useState } from "react";
import { BatchList } from "./components/BatchList";
import { TrainingView } from "./components/TrainingView";
import { BatchView } from "./views/BatchView";

type View =
  | { name: "studio" }
  | { name: "batch"; bid: string }
  | { name: "training" };

export default function App() {
  const [view, setView] = useState<View>({ name: "studio" });

  return (
    <div className="app">
      {view.name !== "batch" && (
        <header className="top">
          <button
            className="wordmark"
            onClick={() => setView({ name: "studio" })}
          >
            Son <span className="sub">fine-tune studio</span>
          </button>
          <nav>
            <button
              className={`navbtn${view.name === "studio" ? " on" : ""}`}
              onClick={() => setView({ name: "studio" })}
            >
              batches
            </button>
            <button
              className={`navbtn${view.name === "training" ? " on" : ""}`}
              onClick={() => setView({ name: "training" })}
            >
              training
            </button>
          </nav>
        </header>
      )}
      {view.name === "studio" && (
        <BatchList onOpen={(bid) => setView({ name: "batch", bid })} />
      )}
      {view.name === "batch" && (
        <BatchView key={view.bid} bid={view.bid} onExit={() => setView({ name: "studio" })} />
      )}
      {view.name === "training" && <TrainingView />}
    </div>
  );
}
