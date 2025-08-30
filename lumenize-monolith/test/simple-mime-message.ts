// Simple MIME message builder for testing - compatible with Workers runtime
export class SimpleMimeMessage {
  private headers: Record<string, string> = {};
  private body: string = '';

  setSender(sender: { name?: string; addr: string }) {
    const from = sender.name ? `${sender.name} <${sender.addr}>` : sender.addr;
    this.headers['From'] = from;
    return this;
  }

  setRecipient(recipient: string) {
    this.headers['To'] = recipient;
    return this;
  }

  setSubject(subject: string) {
    this.headers['Subject'] = subject;
    return this;
  }

  addMessage(message: { contentType: string; data: string }) {
    this.headers['Content-Type'] = message.contentType;
    this.body = message.data;
    return this;
  }

  populateFromObject(body: any): this {
    for (const [key, value] of Object.entries(body)) {
      const fn = (this as any)[key];
      if (typeof fn === 'function') {
        if (Array.isArray(value)) {
          fn.apply(this, value);
        } else {
          fn.call(this, value);
        }
      }
    }
    return this;
  }

  asRaw(): string {
    const date = new Date().toUTCString();
    this.headers['Date'] = date;
    this.headers['Message-ID'] = `<${crypto.randomUUID()}@test.example.com>`;
    
    let raw = '';
    for (const [key, value] of Object.entries(this.headers)) {
      raw += `${key}: ${value}\r\n`;
    }
    raw += '\r\n';
    raw += this.body;
    
    return raw;
  }
}

export function createMimeMessage() {
  return new SimpleMimeMessage();
}
