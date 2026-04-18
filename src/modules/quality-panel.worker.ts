import {
  analyze_quality_project,
  type QualityAnalysisInput,
} from "./quality-core";

self.onmessage = (event: MessageEvent<{ id: number; input: QualityAnalysisInput }>) => {
  const { id, input } = event.data;

  try {
    const report = analyze_quality_project(input);
    postMessage({ id, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown quality analysis error";
    postMessage({ id, error: message });
  }
};
