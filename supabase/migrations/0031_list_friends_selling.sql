-- 0031_list_friends_selling.sql — Wave 4 D2. Add a per-friend "selling_you_want" count to list_friends so the
-- FRIENDS list can show "Selling N you want". Consent-gated (private.can_view_forsale) and computed to EQUAL the
-- crate the "Selling N you want" link opens (the matchSellingYouWant filter): the friend's COLLECTION rows that
-- are for-sale AND that the viewer wants (exact, plus master-match in the viewer's 'any' mode). Collection-scoped
-- because get_friend_crate renders only the collection — a for-sale listing outside the collection can never be a
-- crate card, so counting it would break count==filter (#43). Body = live def verbatim + the new field.
create or replace function public.list_friends()
returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  with me as (select auth.jwt()->>'sub' as sub),
       mm as (select coalesce((select match_mode from public.profiles where user_id = (select sub from me)), 'exact') as mode)
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', pr.user_id,
           'discogs_username', pr.discogs_username,
           'display_name', pr.display_name,
           'avatar_url', pr.avatar_url,
           'crate_visibility', pr.crate_visibility,
           'selling_you_want',
             case when private.can_view_forsale((select sub from me), pr.user_id) then (
               -- Count CARDS, not distinct releases: get_friend_crate renders one row per collection_items row
               -- (no DISTINCT), and D1's header + the FOR SALE facet both count those cards. Iterating
               -- collection_items (not inventory) makes selling_you_want == the filtered crate a friend owning
               -- the same wanted+for-sale release twice shows two cards (#43).
               select count(*)
                 from public.collection_items ci
                 left join public.releases rci on rci.release_id = ci.release_id
                where ci.user_id = pr.user_id
                  and exists (select 1 from public.inventory_items ii
                               where ii.user_id = pr.user_id and ii.release_id = ci.release_id and ii.status = 'for_sale')
                  and (
                    exists (select 1 from public.wantlist_items wi
                             where wi.user_id = (select sub from me) and wi.release_id = ci.release_id)
                    or ( (select mode from mm) = 'any' and rci.master_id is not null and rci.master_id <> 0
                         and exists (select 1 from public.wantlist_items wi
                                       join public.releases rw on rw.release_id = wi.release_id
                                      where wi.user_id = (select sub from me) and rw.master_id = rci.master_id) )
                  )
             ) else 0 end
         ) order by lower(coalesce(pr.display_name, pr.discogs_username, pr.user_id))), '[]'::jsonb)
    from public.friendships f
    join public.profiles pr on pr.user_id = f.friend_id
   where f.user_id = (select sub from me);
$function$;
