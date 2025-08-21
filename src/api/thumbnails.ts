import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from 'path'
import { randomBytes } from 'crypto'



export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);
  const formData = await req.formData()
  const thumbnailFile = formData.get("thumbnail")
  if (!(thumbnailFile instanceof File)) {
    throw new BadRequestError("No thumbnail file provided")
  }

  const MAX_UPLOAD_SIZE = 10 << 20 // 10*1024*1024 = 10MB
  if (thumbnailFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 10MB limit")
  }

  const mediaType = thumbnailFile.type;
  let fileExtension = "";
  if (mediaType === "image/png") {
    fileExtension = "png";
  } else if (mediaType === "image/jpeg" || mediaType === "image/jpg") {
    fileExtension = "jpg";
  } else if (mediaType === "image/gif") {
    fileExtension = "gif";
  } else if (mediaType === "image/webp") {
    fileExtension = "webp";
  } else {
    // Default fallback - extract from type or use a default
    fileExtension = mediaType.split("/")[1] || "png";
  }
  const randomBuffer = randomBytes(32);
  const randomFileName = randomBuffer.toString("base64url")
  const fileName = `${randomFileName}.${fileExtension}`
  const filePath = path.join(cfg.assetsRoot, fileName)
  const data = await thumbnailFile.arrayBuffer()
  await Bun.write(filePath, data)
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to upload thumbnail for this video");
  }

  const thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}`;
  const updatedVideo = {
    ...video,
    thumbnailURL
  }

  updateVideo(cfg.db, updatedVideo)
  return respondWithJSON(200, updatedVideo);
}
