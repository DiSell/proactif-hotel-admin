/**
 * Minimal ambient type declaration for the `nodemailer` package — it ships
 * no TypeScript types of its own, and `@types/nodemailer` was deliberately
 * NOT added as a second package (this project adds exactly one dependency
 * for SMTP sending: `nodemailer` itself — see smtp.ts's own header
 * comment). Only the narrow surface this codebase actually calls is
 * declared: createTransport() + Transporter.sendMail(). Extend this file
 * if a future change needs another nodemailer option/return field.
 */
declare module "nodemailer" {
  export interface TransportAuth {
    user: string;
    pass: string;
  }

  export interface TransportOptions {
    host: string;
    port: number;
    secure: boolean;
    auth: TransportAuth;
  }

  export interface SendMailOptions {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }

  export interface SentMessageInfo {
    messageId: string;
  }

  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>;
  }

  export function createTransport(options: TransportOptions): Transporter;
}
