export interface WizardState {
  name: string;
  website: string;
  logoFile: File | null;
  logoPreviewUrl: string | null;
  logoUrl: string | null;
  address: string;
  postal_code: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  primary_color: string;
  secondary_color: string;
  languages: string[];
  default_language: string;
  booking_url: string;
  spa_booking_url: string;
  assistant_enabled: boolean;
  assistant_name: string;
  welcome_message: string;
}

export const initialWizardState: WizardState = {
  name: "",
  website: "",
  logoFile: null,
  logoPreviewUrl: null,
  logoUrl: null,
  address: "",
  postal_code: "",
  city: "",
  country: "France",
  phone: "",
  email: "",
  primary_color: "#1A1D1A",
  secondary_color: "#8A6A3E",
  languages: ["fr"],
  default_language: "fr",
  booking_url: "",
  spa_booking_url: "",
  assistant_enabled: true,
  assistant_name: "",
  welcome_message: "",
};

export type FieldErrors = Record<string, string>;
