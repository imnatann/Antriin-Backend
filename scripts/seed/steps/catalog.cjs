'use strict';

const { id, NAMESPACE } = require('../lib/ids.cjs');

/** Menu categories, items and their option groups/choices. */
async function run(client, { tenant, categories, menu }) {
  for (const category of categories) {
    await client.query(
      `insert into menu_categories (id, tenant_id, name, sort_order, status)
       values ($1, $2, $3, $4, 'active')
       on conflict (id) do update
         set tenant_id = excluded.tenant_id, name = excluded.name,
             sort_order = excluded.sort_order, status = 'active',
             updated_at = now()`,
      [category.id, tenant.id, category.name, category.sortOrder],
    );
  }

  let choiceIndex = 0;
  for (const [itemIndex, item] of menu.entries()) {
    await client.query(
      `insert into menu_items
         (id, tenant_id, category_id, name, description, price_minor, currency, status)
       values ($1, $2, $3, $4, $5, $6, 'IDR', 'active')
       on conflict (id) do update
         set tenant_id = excluded.tenant_id, category_id = excluded.category_id,
             name = excluded.name, description = excluded.description,
             price_minor = excluded.price_minor, status = 'active',
             archived_at = null, updated_at = now()`,
      [
        item.id,
        tenant.id,
        item.categoryId,
        item.name,
        item.description,
        item.priceMinor,
      ],
    );

    if (!item.optionGroup) continue;
    const groupId = id(NAMESPACE.optionGroup, itemIndex + 1);
    await client.query(
      `insert into menu_option_groups
         (id, tenant_id, menu_item_id, name, min_selections, max_selections, sort_order, status)
       values ($1, $2, $3, $4, $5, $6, 1, 'active')
       on conflict (id) do update
         set tenant_id = excluded.tenant_id, menu_item_id = excluded.menu_item_id,
             name = excluded.name, min_selections = excluded.min_selections,
             max_selections = excluded.max_selections, status = 'active',
             updated_at = now()`,
      [
        groupId,
        tenant.id,
        item.id,
        item.optionGroup.name,
        item.optionGroup.minSelections,
        item.optionGroup.maxSelections,
      ],
    );

    for (const choice of item.optionGroup.choices) {
      choiceIndex += 1;
      await client.query(
        `insert into menu_option_choices
           (id, tenant_id, group_id, name, price_delta_minor, status)
         values ($1, $2, $3, $4, $5, 'active')
         on conflict (group_id, name) do update
           set price_delta_minor = excluded.price_delta_minor, status = 'active',
               updated_at = now()`,
        [
          id(NAMESPACE.optionChoice, choiceIndex),
          tenant.id,
          groupId,
          choice.name,
          choice.priceDeltaMinor,
        ],
      );
    }
  }

  return {
    categories: categories.length,
    menuItems: menu.length,
    optionChoices: choiceIndex,
  };
}

module.exports = { run };
