import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { type ApiConfig } from "../config";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import type { BunRequest } from "bun";
import path from 'path';
import { randomBytes } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';

export async function getVideoAspectRatio(filePath: string) {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const outputText = await new Response(process.stdout).text();
  const errorText = await new Response(process.stderr).text();

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${errorText}`);
  }

  const output = JSON.parse(outputText);
  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { width, height } = output.streams[0];

  return width === Math.floor(16 * (height / 9))
    ? "landscape"
    : height === Math.floor(16 * (width / 9))
      ? "portrait"
      : "other";
}
export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video for video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to upload video for this video");
  }

  const formData = await req.formData();
  const videoFile = formData.get("video");

  if (!(videoFile instanceof File)) {
    throw new BadRequestError("No video file provided");
  }

  const MAX_UPLOAD_SIZE = 1 << 30; // 1 GB
  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 1GB limit");
  }

  // Validate the uploaded file to ensure it's an MP4 video
  if (videoFile.type !== "video/mp4") {
    throw new BadRequestError("Only MP4 video files are allowed");
  }

  const randomBuffer = randomBytes(32);
  const randomFileName = randomBuffer.toString("hex");
  const fileName = `${randomFileName}.mp4`;
  const tempFilePath = path.join(cfg.assetsRoot, `temp_${fileName}`);

  const data = await videoFile.arrayBuffer();
  await Bun.write(tempFilePath, data);
  try {
    const aspectRatio = await getVideoAspectRatio(tempFilePath)
    const s3Key = `${aspectRatio}/${fileName}`;
    // Use just the fileName without the s3:// prefix and bucket name
    await cfg.s3Client.write(s3Key, Bun.file(tempFilePath), {
      type: videoFile.type
    });

    // Update the VideoURL in the database
    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Key}`;
    const updatedVideo = {
      ...video,
      videoURL
    };

    updateVideo(cfg.db, updatedVideo);
    return respondWithJSON(200, updatedVideo);

  } finally {
    try {
      await Bun.write(tempFilePath, ""); // Clear the file
    } catch (error) {
      console.warn("Failed to clean up temporary file:", tempFilePath);
    }
  }
}