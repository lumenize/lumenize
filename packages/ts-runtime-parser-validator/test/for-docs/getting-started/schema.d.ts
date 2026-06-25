// schema.d.ts
interface Address {
  street: string;
  city: string;
  /** @default "US" */
  country?: string;
}

interface User {
  name: string;
  home: Address;
}
