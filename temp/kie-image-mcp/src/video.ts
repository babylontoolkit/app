/** kie-video server: kie.ai video via the generic jobs endpoint (Kling, Bytedance Seedance, Grok). */
import { API, createClient, download, expand, sleep, serve, makeLog } from "./core.js";

const UA = "Mozilla/5.0 (compatible; kie-video-mcp/1.0)";
const DEFAULT_MODEL = "kling-3.0/video";
const log = makeLog("kie-video");
const { req, upload } = createClient(UA);

function buildInput(
  model: string,
  prompt: string,
  imageUrls: string[],
  aspect: string,
  duration: number,
  sound: boolean,
  resolution: string | undefined,
  mode: string
): Record<string, unknown> {
  if (model.startsWith("kling")) {
    const inp: Record<string, unknown> = {
      prompt,
      sound,
      aspect_ratio: aspect,
      duration: String(duration),
    };
    if (model === "kling-3.0/video") {
      inp.mode = mode;
      inp.multi_shots = false;
    }
    if (imageUrls.length) inp.image_urls = imageUrls;
    return inp;
  }
  if (model.startsWith("bytedance")) {
    const inp: Record<string, unknown> = {
      prompt,
      aspect_ratio: aspect,
      duration,
      generate_audio: sound,
    };
    if (resolution) inp.resolution = resolution;
    if (imageUrls.length >= 1) inp.first_frame_url = imageUrls[0];
    if (imageUrls.length >= 2) inp.last_frame_url = imageUrls[1];
    return inp;
  }
  // Grok Imagine and any future models
  const inp: Record<string, unknown> = { prompt, aspect_ratio: aspect, duration };
  if (resolution) inp.resolution = resolution;
  if (imageUrls.length) inp.image_urls = imageUrls;
  return inp;
}

async function generateVideo(args: any): Promise<string> {
  const prompt: string = args.prompt;
  const outPath = expand(args.out_path);
  const model: string = args.model || DEFAULT_MODEL;
  const imgs: string[] = args.image_paths || [];
  const aspect: string = args.aspect_ratio || "16:9";
  const duration = parseInt(String(args.duration ?? 5), 10);
  const sound = Boolean(args.sound ?? false);
  const resolution: string | undefined = args.resolution;
  const mode: string = args.mode || "pro";

  const imageUrls: string[] = [];
  for (const p of imgs) imageUrls.push(await upload(expand(p), "mcp-video-other"));
  const inp = buildInput(model, prompt, imageUrls, aspect, duration, sound, resolution, mode);

  const task = await req(`${API}/api/v1/jobs/createTask`, "POST", { model, input: inp });
  const tid = task?.data?.taskId;
  if (!tid) throw new Error(`createTask failed: ${JSON.stringify(task).slice(0, 300)}`);
  log("task", tid, "submitted; polling");

  let resultUrl: string | undefined;
  const deadline = Date.now() + 900_000; // video renders are slower than images
  while (Date.now() < deadline) {
    await sleep(10_000);
    const info = await req(`${API}/api/v1/jobs/recordInfo?taskId=${tid}`);
    const d = info?.data || {};
    const state = d.state || d.status;
    const flag = d.successFlag;
    log("state:", state, "flag:", flag);
    if (state === "success" || state === "completed" || flag === 1) {
      const rj = d.resultJson || d.response;
      if (typeof rj === "string" && rj) {
        try {
          const parsed = JSON.parse(rj);
          const urls = parsed.resultUrls || parsed.fullResultUrls;
          resultUrl = (urls && urls[0]) || parsed.videoUrl || parsed.mp4Url;
        } catch {
          /* fall through */
        }
      }
      if (!resultUrl) {
        const urls = d.resultUrls || d.fullResultUrls;
        if (urls && urls.length) resultUrl = urls[0];
      }
      if (!resultUrl)
        throw new Error(`succeeded but no result url: ${JSON.stringify(info).slice(0, 300)}`);
      break;
    }
    if (state === "fail" || state === "failed" || flag === 2 || flag === 3) {
      const msg = d.errorMessage || d.msg || JSON.stringify(info).slice(0, 300);
      throw new Error(`generation failed: ${msg}`);
    }
  }
  if (!resultUrl) throw new Error("timed out waiting for result (900s)");

  await download(resultUrl, outPath, UA);
  log("saved ->", outPath);
  return `Video generated and saved to ${outPath}\nModel: ${model}\nSource URL (expires ~14 days): ${resultUrl}`;
}

const TOOLS = [
  {
    name: "generate_video",
    description:
      "Generate a video with kie.ai (Kling, Bytedance Seedance, or Grok Imagine) using the " +
      "/api/v1/jobs/createTask endpoint, and save it to a local path. Optionally pass local image " +
      "files (image_paths) for image-to-video: 1 image = first frame, 2 images = first + last frame " +
      "(Kling/Bytedance). Default model is kling-3.0/video.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the video to generate." },
        out_path: { type: "string", description: "Path to save the resulting video (.mp4)." },
        model: {
          type: "string",
          description:
            "kie.ai video model slug. Default kling-3.0/video. Options: kling-3.0/video, " +
            "kling-2.6/text-to-video, kling-2.6/image-to-video, kling-2.5/turbo-text-to-video-pro, " +
            "kling-2.5/turbo-image-to-video-pro, kling-v2.1/master-text-to-video, " +
            "kling-v2.1/master-image-to-video, bytedance/seedance-2, bytedance/seedance-2-fast, " +
            "bytedance/seedance-1.5-pro, bytedance/v1-pro-text-to-video, bytedance/v1-pro-image-to-video, " +
            "bytedance/v1-lite-text-to-video, bytedance/v1-lite-image-to-video, grok-imagine-video-1-5-preview.",
        },
        image_paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional local image paths. 1 = first frame, 2 = first + last frame.",
        },
        aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"], description: "Aspect ratio. Default 16:9." },
        duration: { type: "integer", description: "Video duration in seconds. Default 5. Valid range varies by model." },
        sound: { type: "boolean", description: "Generate audio with the video (Kling / Bytedance). Default false." },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], description: "Output resolution (Bytedance / Grok). Optional." },
        mode: { type: "string", enum: ["std", "pro", "4K"], description: "Resolution tier for kling-3.0/video only. Default pro." },
      },
      required: ["prompt", "out_path"],
    },
  },
];

export function run(): void {
  serve({
    name: "kie-video",
    version: "1.0.0",
    tools: TOOLS,
    call: (_name, args) => generateVideo(args),
  });
}
