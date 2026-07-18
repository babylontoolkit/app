/** kie-google server: kie.ai Google Veo 3.1 video via the dedicated veo endpoints. */
import { API, createClient, download, expand, sleep, serve, makeLog } from "./core.js";

const UA = "Mozilla/5.0 (compatible; kie-google-mcp/1.0)";
const DEFAULT_MODEL = "veo3_fast";
const log = makeLog("kie-google");
const { req, upload } = createClient(UA);

async function generateGoogleVideo(args: any): Promise<string> {
  const prompt: string = args.prompt;
  const outPath = expand(args.out_path);
  const imgs: string[] = args.image_paths || [];
  const model: string = args.model || DEFAULT_MODEL;
  const aspect: string = args.aspect_ratio || "16:9";
  const resolution: string = args.resolution || "720p";
  const duration = parseInt(String(args.duration ?? 8), 10);
  const genType: string | undefined = args.generation_type;
  const watermark: string | undefined = args.watermark;
  const enableTranslation = Boolean(args.enable_translation ?? true);

  const imageUrls: string[] = [];
  for (const p of imgs) imageUrls.push(await upload(expand(p), "mcp-veo"));

  // Veo 3.1 uses a flat request body (not the {model, input} jobs wrapper).
  const payload: Record<string, unknown> = {
    prompt,
    model,
    aspect_ratio: aspect,
    resolution,
    duration,
    enableTranslation,
  };
  if (imageUrls.length) payload.imageUrls = imageUrls;
  if (genType) payload.generationType = genType;
  if (watermark) payload.watermark = watermark;

  const task = await req(`${API}/api/v1/veo/generate`, "POST", payload);
  if (task?.code !== 200) throw new Error(`generate failed: ${JSON.stringify(task).slice(0, 300)}`);
  const tid = task?.data?.taskId;
  if (!tid) throw new Error(`generate failed (no taskId): ${JSON.stringify(task).slice(0, 300)}`);
  log("task", tid, "submitted; polling");

  let resultUrl: string | undefined;
  const deadline = Date.now() + 900_000; // video renders are slower than images
  while (Date.now() < deadline) {
    await sleep(10_000);
    const info = await req(`${API}/api/v1/veo/record-info?taskId=${tid}`);
    const d = info?.data || {};
    const flag = d.successFlag;
    log("successFlag:", flag);
    if (flag === 1) {
      const resp = d.response || {};
      const urls = resp.resultUrls || resp.fullResultUrls;
      if (!urls || !urls.length)
        throw new Error(`succeeded but no result url: ${JSON.stringify(info).slice(0, 300)}`);
      resultUrl = urls[0];
      break;
    }
    if (flag === 2 || flag === 3) {
      const msg = d.errorMessage || d.msg || JSON.stringify(info).slice(0, 300);
      throw new Error(`generation failed (flag=${flag}): ${msg}`);
    }
  }
  if (!resultUrl) throw new Error("timed out waiting for result (900s)");

  await download(resultUrl, outPath, UA);
  log("saved ->", outPath);
  return `Veo 3.1 video generated and saved to ${outPath}\nSource URL (expires ~14 days): ${resultUrl}`;
}

const TOOLS = [
  {
    name: "generate_google_video",
    description:
      "Generate a video with kie.ai Google Veo 3.1 and save it to a local path. Optionally pass " +
      "local image files (image_paths) for image-to-video: 1 image animates around it, 2 images = " +
      "first + last frame transition, up to 3 images with generation_type=REFERENCE_2_VIDEO.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the video to generate." },
        out_path: { type: "string", description: "Path to save the resulting video (.mp4)." },
        image_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional local image paths. 1 = animate around image, 2 = first+last frame, up to 3 = reference (fast/lite).",
        },
        model: {
          type: "string",
          enum: ["veo3", "veo3_fast", "veo3_lite"],
          description: "Veo 3.1 model. Default veo3_fast (veo3 = highest quality).",
        },
        aspect_ratio: { type: "string", enum: ["16:9", "9:16", "Auto"], description: "Aspect ratio. Default 16:9." },
        resolution: { type: "string", enum: ["720p", "1080p", "4k"], description: "Output resolution. Default 720p (4k costs extra credits)." },
        duration: { type: "integer", enum: [4, 6, 8], description: "Video length in seconds. Default 8." },
        generation_type: {
          type: "string",
          enum: ["TEXT_2_VIDEO", "FIRST_AND_LAST_FRAMES_2_VIDEO", "REFERENCE_2_VIDEO"],
          description: "Optional generation mode. Auto-detected from image_paths if omitted.",
        },
        watermark: { type: "string", description: "Optional watermark text to burn into the video." },
        enable_translation: { type: "boolean", description: "Translate prompt to English before generating. Default true." },
      },
      required: ["prompt", "out_path"],
    },
  },
];

export function run(): void {
  serve({
    name: "kie-google",
    version: "1.0.0",
    tools: TOOLS,
    call: (_name, args) => generateGoogleVideo(args),
  });
}
