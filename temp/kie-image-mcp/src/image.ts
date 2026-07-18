/** kie-image server: kie.ai image generation (Nano Banana 2 and more). */
import { API, createClient, download, expand, sleep, serve, makeLog } from "./core.js";

const UA = "Mozilla/5.0 (compatible; kie-image-mcp/1.0)";
const DEFAULT_MODEL = "nano-banana-2";
const log = makeLog("kie-image");
const { req, upload } = createClient(UA);

async function generateImage(args: any): Promise<string> {
  const prompt: string = args.prompt;
  const outPath = expand(args.out_path);
  const refs: string[] = args.reference_paths || [];
  const model: string = args.model || DEFAULT_MODEL;
  const aspect: string = args.aspect_ratio || "16:9";
  const resolution: string = args.resolution || "2K";
  const outFormat: string = args.output_format || "jpg";

  const image_input: string[] = [];
  for (const p of refs) image_input.push(await upload(expand(p), "mcp-image"));

  const task = await req(`${API}/api/v1/jobs/createTask`, "POST", {
    model,
    input: { prompt, image_input, aspect_ratio: aspect, resolution, output_format: outFormat },
  });
  const tid = task?.data?.taskId;
  if (!tid) throw new Error(`createTask failed: ${JSON.stringify(task).slice(0, 300)}`);
  log("task", tid, "submitted; polling");

  let resultUrl: string | undefined;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(6000);
    const info = await req(`${API}/api/v1/jobs/recordInfo?taskId=${tid}`);
    const d = info?.data || {};
    const state = d.state || d.status;
    log("state:", state);
    if (state === "success" || state === "completed" || d.successFlag === 1) {
      let urls: string[] | undefined;
      const rj = d.resultJson || d.response;
      if (typeof rj === "string" && rj) {
        try {
          urls = JSON.parse(rj).resultUrls;
        } catch {
          /* fall through */
        }
      }
      urls = urls || d.resultUrls;
      if (!urls || !urls.length)
        throw new Error(`succeeded but no result url: ${JSON.stringify(info).slice(0, 300)}`);
      resultUrl = urls[0];
      break;
    }
    if (state === "fail" || state === "failed" || d.successFlag === 2 || d.successFlag === 3)
      throw new Error(`generation failed: ${JSON.stringify(info).slice(0, 300)}`);
  }
  if (!resultUrl) throw new Error("timed out waiting for result (300s)");

  await download(resultUrl, outPath, UA);
  log("saved ->", outPath);
  return `Image generated and saved to ${outPath}\nSource URL (expires ~3 days): ${resultUrl}`;
}

const TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate an image with kie.ai (default Nano Banana 2) and save it to a local path. " +
      "Optionally pass local reference image files (reference_paths) to composite/edit from.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image to generate." },
        out_path: { type: "string", description: "Path to save the resulting image." },
        reference_paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional local image file paths to use as references (up to 14).",
        },
        model: { type: "string", description: "kie.ai image model to use. Default nano-banana-2." },
        aspect_ratio: { type: "string", description: "e.g. 16:9, 1:1, 4:3, 9:16. Default 16:9." },
        resolution: { type: "string", enum: ["1K", "2K", "4K"], description: "Default 2K." },
        output_format: { type: "string", enum: ["jpg", "png"], description: "Default jpg." },
      },
      required: ["prompt", "out_path"],
    },
  },
];

export function run(): void {
  serve({
    name: "kie-image",
    version: "1.0.0",
    tools: TOOLS,
    call: (_name, args) => generateImage(args),
  });
}
