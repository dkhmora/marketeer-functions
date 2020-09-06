const functions = require("firebase-functions");
const firestoreGCP = require("@google-cloud/firestore");
const client = new firestoreGCP.v1.FirestoreAdminClient();
const mkdirp = require("mkdirp");
const spawn = require("child-process-promise").spawn;
const path = require("path");
const os = require("os");
const fs = require("fs");

exports.scheduledFirestoreExport = functions
  .region("asia-northeast1")
  .pubsub.schedule("every 24 hours")
  .onRun((context) => {
    const bucket = "gs://marketeer-backup-bucket";
    const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
    const databaseName = client.databasePath(projectId, "(default)");

    return client
      .exportDocuments({
        name: databaseName,
        outputUriPrefix: bucket,
        collectionIds: [],
      })
      .then((responses) => {
        const response = responses[0];
        return functions.logger.log(`Operation Name: ${response["name"]}`);
      })
      .catch((err) => {
        functions.logger.error(err);
        throw new Error("Export operation failed");
      });
  });

  exports.generateThumbnail = functions.storage
  .object()
  .onFinalize(async (object) => {
    // Thumbnail prefix added to file names.
    const THUMB_PREFIX = "thumb_";

    // Max height and width of the thumbnail in pixels.
    const THUMB_MAX_HEIGHT = 360;
    const THUMB_MAX_WIDTH = 360;

    // File and directory paths.
    const filePath = object.name;
    const contentType = object.contentType; // This is the image MIME type
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const thumbFilePath = path.normalize(
      path.join(fileDir, `${THUMB_PREFIX}${fileName}`)
    );
    const tempLocalFile = path.join(os.tmpdir(), filePath);
    const tempLocalDir = path.dirname(tempLocalFile);
    const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

    functions.logger.log("directory", fileDir);
    if (
      fileDir.search("/images/orders") >= 0 ||
      fileDir.search("/images/store_categories") >= 0
    ) {
      return functions.logger.log("Will not process order images");
    }

    // Exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith("image/")) {
      return functions.logger.log("This is not an image.");
    }

    // Exit if the image is already a thumbnail.
    if (fileName.startsWith(THUMB_PREFIX)) {
      return functions.logger.log("Already a Thumbnail.");
    }

    // Cloud Storage files.
    const bucket = admin.storage().bucket(object.bucket);
    const file = bucket.file(filePath);
    const metadata = {
      contentType: contentType,
      // To enable Client-side caching you can set the Cache-Control headers here. Uncomment below.
      // 'Cache-Control': 'public,max-age=3600',
    };

    // Create the temp directory where the storage file will be downloaded.
    await mkdirp(tempLocalDir);
    // Download file from bucket.
    await file.download({ destination: tempLocalFile });
    functions.logger.log("The file has been downloaded to", tempLocalFile);
    // Generate a thumbnail using ImageMagick.
    await spawn(
      "convert",
      [
        tempLocalFile,
        "-thumbnail",
        `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`,
        tempLocalThumbFile,
      ],
      { capture: ["stdout", "stderr"] }
    );
    functions.logger.log("Thumbnail created at", tempLocalThumbFile);
    // Uploading the Thumbnail.
    await bucket.upload(tempLocalThumbFile, {
      destination: thumbFilePath,
      metadata: metadata,
    });
    console.log("Thumbnail uploaded to Storage at", thumbFilePath);
    // Once the image has been uploaded delete the local files to free up disk space.
    fs.unlinkSync(tempLocalFile);
    fs.unlinkSync(tempLocalThumbFile);

    return functions.logger.log("Thumbnail saved to storage.");
  });