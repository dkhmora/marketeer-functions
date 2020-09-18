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

  transporter.verify((error, success) => {
    if (error) {
      functions.logger.log(error);
    } else {
      ejs.renderFile(
        path.join(__dirname, "../email_templates/disbursement.ejs"),
        {
          user_name: userName,
          date_issued: dateIssued,
        },
        (err, data) => {
          if (err) {
            functions.logger.error(err);
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

            transporter.sendMail(mailOptions, (err, info) => {
              if (err) {
                functions.logger.error(err);
              } else {
                return functions.logger.log(
                  "Disbursement email sent to:",
                  userEmail
                );
              }
            });

            transporter.close();
          }
        }
      );
    }
  });
};
