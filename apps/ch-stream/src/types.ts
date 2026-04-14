export type CHStreamEvent = {
  resource_id: string;
  resource_kind: string;
  resource_uri: string;
  event: {
    type: 'changed' | 'deleted';
    published_at: string;
    timepoint: number;
    fields_changed: string[];
  };
  data: CHCompanyProfile;
};

export type CHCompanyProfile = {
  company_number: string;
  company_name: string;
  company_status?: string;
  type?: string;
  date_of_creation?: string;
  registered_office_address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
  sic_codes?: string[];
  accounts?: {
    next_made_up_to?: string;
    last_accounts?: { made_up_to?: string };
    overdue?: boolean;
  };
  jurisdiction?: string;
  has_been_liquidated?: boolean;
  has_insolvency_history?: boolean;
  has_charges?: boolean;
  previous_company_names?: { name: string }[];
  confirmation_statement?: { last_made_up_to?: string };
};
