const nodemailer = require("nodemailer");
const { admin } = require("../util/admin");
const ejs = require("ejs");
const path = require("path");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const functions = require("firebase-functions");
const client = new SecretManagerServiceClient();

const getBusinessEmailKey = async () => {
  const [accessResponse] = await client.accessSecretVersion({
    name:
      "projects/1549607298/secrets/marketeer_business_email_pass/versions/latest",
  });
  const secretKey = accessResponse.payload.data.toString("utf8");

  return secretKey;
};

exports.notifyUserOfOrderConfirmation = async ({
  fileName,
  filePath,
  userEmail,
  userName,
  dateIssued,
}) => {
  const file = admin.storage().bucket().file(`${filePath}/${fileName}`);

  const mailerConfig = {
    host: "smtpout.secureserver.net",
    secure: true,
    secureConnection: false,
    tls: {
      ciphers: "SSLv3",
    },
    requireTLS: true,
    port: 465,
    debug: true,
    auth: {
      user: "business@marketeer.ph",
      pass: await getBusinessEmailKey(),
    },
  };

  const transporter = nodemailer.createTransport(mailerConfig);

  ejs.renderFile(
    path.join(__dirname, "../email_templates/disbursement.ejs"),
    {
      user_name: userName,
    },
    (err, data) => {
      if (err) {
        functions.logger.log(err);
      } else {
        const mailOptions = {
          from: mailerConfig.auth.user,
          to: userEmail,
          subject: `Disbursement Invoice for ${dateIssued}`,
          html: data,
          attachments: [
            {
              filename: fileName,
              content: file.createReadStream(),
            },
          ],
        };

        transporter.sendMail(mailOptions);

        transporter.close();
      }
    }
  );

  return console.log("Disbursement email sent to:", userEmail);
};
