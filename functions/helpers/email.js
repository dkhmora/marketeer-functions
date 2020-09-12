const nodemailer = require("nodemailer");
const { admin } = require("../util/admin");

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
      user: "**********",
      pass: "**********",
    },
  };

  const transporter = nodemailer.createTransport(mailerConfig);

  const mailOptions = {
    from: mailerConfig.auth.user,
    to: userEmail,
  };

  mailOptions.subject = `Disbursement Invoice for ${dateIssued}`;
  mailOptions.text = `Hello ${userName}! Attached is your Disbursement Invoice for ${dateIssued}.`;

  mailOptions.attachments = [
    {
      filename: fileName,
      content: file.createReadStream(),
    },
  ];

  await transporter.sendMail(mailOptions);

  return console.log("New welcome email sent to:", userEmail);
};
