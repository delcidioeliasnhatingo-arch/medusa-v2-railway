import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import DebitoPayPaymentProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [DebitoPayPaymentProviderService],
})
