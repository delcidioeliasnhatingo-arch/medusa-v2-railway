import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductCategoriesWorkflow,
  createProductOptionsWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createStockLocationsWorkflow,
  createStoresWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * AVEART staging-only seed.
 *
 * Safety: this script is opt-in and does nothing unless AVEART_STAGING_SEED=true.
 * Set it only on a fresh, isolated staging database. It creates test catalogue
 * records, a ZA/ZAR region, a publishable key, a sales channel and test inventory.
 * It does not configure a live payment provider, shipping options, or suppliers.
 */
export default async function aveart_staging_seed({
  container,
}: {
  container: MedusaContainer;
}) {
  if (process.env.AVEART_STAGING_SEED !== "true") {
    console.info(
      "[aveart-staging-seed] Skipped safely; set AVEART_STAGING_SEED=true only for a fresh isolated staging database.",
    );
    return;
  }

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info("Starting AVEART staging seed (ZA/ZAR; no live payment/shipping setup).");

  const { result: [salesChannel] } = await createSalesChannelsWorkflow(container).run({
    input: {
      salesChannelsData: [
        {
          name: "AVEART Staging",
          description: "Non-production sales channel for catalogue and cart integration tests.",
        },
      ],
    },
  });

  const { result: [publishableKey] } = await createApiKeysWorkflow(container).run({
    input: {
      api_keys: [
        {
          title: "AVEART Staging Storefront",
          type: "publishable",
          created_by: "",
        },
      ],
    },
  });

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: publishableKey.id, add: [salesChannel.id] },
  });

  await createStoresWorkflow(container).run({
    input: {
      stores: [
        {
          name: "AVEART Staging Store",
          supported_currencies: [{ currency_code: "zar", is_default: true }],
          default_sales_channel_id: salesChannel.id,
        },
      ],
    },
  });

  const { result: regionResult } = await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: "South Africa",
          currency_code: "zar",
          countries: ["za"],
        },
      ],
    },
  });
  const region = regionResult[0];

  const { result: categories } = await createProductCategoriesWorkflow(container).run({
    input: {
      product_categories: [
        { name: "Women's Clothing", handle: "womens-clothing", is_active: true },
        { name: "Men's Clothing", handle: "mens-clothing", is_active: true },
        { name: "Accessories", handle: "accessories", is_active: true },
      ],
    },
  });

  const { result: options } = await createProductOptionsWorkflow(container).run({
    input: {
      product_options: [
        { title: "Size", values: ["S", "M", "L"] },
        { title: "Color", values: ["Black", "White"] },
      ],
    },
  });
  const sizeOption = options.find((option) => option.title === "Size");
  const colorOption = options.find((option) => option.title === "Color");
  if (!sizeOption || !colorOption) throw new Error("Could not create required staging product options.");

  const graph = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
  });
  const shippingProfileId = graph.data[0]?.id;
  if (!shippingProfileId) {
    throw new Error("No Medusa shipping profile exists yet. Ensure core migrations completed before seeding.");
  }

  const { result: stockLocations } = await createStockLocationsWorkflow(container).run({
    input: {
      locations: [
        {
          name: "AVEART Staging Stock",
          address: {
            city: "Johannesburg",
            country_code: "ZA",
            address_1: "Staging only - no physical dispatch",
          },
        },
      ],
    },
  });
  const stockLocation = stockLocations[0];

  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: stockLocation.id, add: [salesChannel.id] },
  });

  const womenCategory = categories.find((category) => category.handle === "womens-clothing");
  const menCategory = categories.find((category) => category.handle === "mens-clothing");
  const accessoriesCategory = categories.find((category) => category.handle === "accessories");
  if (!womenCategory || !menCategory || !accessoriesCategory) {
    throw new Error("Could not create AVEART staging categories.");
  }

  await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "AVEART Staging Linen Shirt",
          handle: "aveart-staging-linen-shirt",
          description: "Non-production test item for validating the AVEART catalogue and cart integration.",
          category_ids: [womenCategory.id],
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfileId,
          weight: 250,
          images: [{ url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/tee-black-front.png" }],
          options: [{ id: sizeOption.id }, { id: colorOption.id }],
          sales_channels: [{ id: salesChannel.id }],
          variants: ["S", "M", "L"].flatMap((size) =>
            ["Black", "White"].map((color) => ({
              title: `${size} / ${color}`,
              sku: `AVEART-STG-SHIRT-${size}-${color.toUpperCase()}`,
              options: { Size: size, Color: color },
              prices: [{ amount: 799, currency_code: "zar" }],
            }))),
        },
        {
          title: "AVEART Staging Essential Tee",
          handle: "aveart-staging-essential-tee",
          description: "Non-production test item for validating the AVEART catalogue and cart integration.",
          category_ids: [menCategory.id],
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfileId,
          weight: 200,
          images: [{ url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/tee-white-front.png" }],
          options: [{ id: sizeOption.id }, { id: colorOption.id }],
          sales_channels: [{ id: salesChannel.id }],
          variants: ["S", "M", "L"].flatMap((size) =>
            ["Black", "White"].map((color) => ({
              title: `${size} / ${color}`,
              sku: `AVEART-STG-TEE-${size}-${color.toUpperCase()}`,
              options: { Size: size, Color: color },
              prices: [{ amount: 449, currency_code: "zar" }],
            }))),
        },
        {
          title: "AVEART Staging Tote Bag",
          handle: "aveart-staging-tote-bag",
          description: "Non-production test item for validating the AVEART catalogue and cart integration.",
          category_ids: [accessoriesCategory.id],
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfileId,
          weight: 150,
          images: [{ url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/sweatshirt-vintage-front.png" }],
          options: [{ id: colorOption.id }],
          sales_channels: [{ id: salesChannel.id }],
          variants: ["Black", "White"].map((color) => ({
            title: color,
            sku: `AVEART-STG-TOTE-${color.toUpperCase()}`,
            options: { Color: color },
            prices: [{ amount: 299, currency_code: "zar" }],
          })),
        },
      ],
    },
  });

  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku"],
  });
  const stagingItems = inventoryItems.filter((item: { sku?: string | null }) =>
    item.sku?.startsWith("AVEART-STG-"),
  );
  if (stagingItems.length === 0) {
    throw new Error("No AVEART staging inventory items were created; refusing to continue.");
  }

  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: stagingItems.map((item: { id: string }) => ({
        location_id: stockLocation.id,
        stocked_quantity: 10,
        inventory_item_id: item.id,
      })),
    },
  });

  logger.info(`AVEART staging seed complete: region ${region.id} (ZA/ZAR), sales channel ${salesChannel.id}, ${stagingItems.length} inventory items.`);
  logger.info("Open Medusa Admin to copy the AVEART Staging Storefront publishable key; never put server secrets in the frontend.");
}
