import z from 'zod'
import { serviceUrlSchema } from '../../settings/serviceUrl'

/**
 * Schema for Silo server settings. Silo authenticates with an API key owned by
 * an admin account; there is no separate user to pick.
 */
export const siloSettingSchema = z.object({
  silo_url: serviceUrlSchema,
  silo_api_key: z.string().trim().min(1, 'API key is required'),
})

export type SiloSetting = z.infer<typeof siloSettingSchema>
