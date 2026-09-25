// Pass this function to Playwright run-code with an existing page.
// Uses staging dining fixtures; feedback POST is mocked. Local test origin can be replaced.
export default async (page, origin = "http://localhost:5180") => {
 const savedFeedback = await page.evaluate(()=>localStorage.getItem('shumap.feature-feedback'));
 await page.evaluate(()=>localStorage.removeItem('shumap.feature-feedback'));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const checks=[];
 await page.setViewportSize({width:1440,height:900});await page.goto(`${origin}/map?poi=place_baoshan_main-library`);
 await page.getByTestId('desktop-poi-detail').getByRole('heading',{name:'本部图书馆',exact:true}).waitFor();
 await page.getByRole('button',{name:'你觉得搜索好用吗？',exact:true}).click();const dialog=page.getByRole('dialog',{name:'你觉得搜索好用吗？',exact:true});await dialog.waitFor();
 let b=await dialog.boundingBox();if(b.width>500||Math.abs(b.x+b.width/2-720)>2)throw Error('rating not centered');
 if(!await dialog.getByRole('button',{name:'提交',exact:true}).isDisabled())throw Error('unrated enabled');
 await dialog.getByRole('button',{name:'2 星',exact:true}).click();await dialog.getByPlaceholder('哪里不好用？告诉我们，方便改进（可选）').fill('桌面评分测试');
 let payload;await page.route('**/api/public/feature-feedback',route=>{payload=route.request().postDataJSON();return route.fulfill({status:204});});
 await dialog.getByRole('button',{name:'提交',exact:true}).click();await dialog.getByText('感谢反馈！',{exact:true}).waitFor();await dialog.getByRole('button',{name:'完成',exact:true}).click();
 if(payload.page!=='search'||payload.rating!==2||payload.reason!=='桌面评分测试')throw Error('incorrect payload');
 if(await page.getByRole('button',{name:'你觉得搜索好用吗？',exact:true}).count())throw Error('rating not persisted');checks.push('desktop rating submit + persistence (mock)');
 await page.unroute('**/api/public/feature-feedback');
 await page.goto(`${origin}/shuttle`);await page.getByRole('button',{name:'你觉得校车查询好用吗？',exact:true}).waitFor();await page.getByRole('button',{name:'你觉得校车查询好用吗？',exact:true}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});checks.push('shuttle desktop rating + Escape');
 for(const width of [1440,1024,768]){
  await page.setViewportSize({width,height:900});await page.goto(`${origin}/map?poi=place_baoshan_4th-canteen`);await page.getByTestId('desktop-poi-detail').waitFor();await page.getByRole('button',{name:'查看2层餐厅（测试）',exact:true}).click();await page.getByRole('heading',{name:'2F · 2层餐厅（测试）',exact:true}).waitFor();
  const grid=await page.getByTestId('dining-desktop-grid').boundingBox();if(grid.x<0||grid.x+grid.width>width)throw Error('dining overflow '+width);
  await page.getByRole('button',{name:'1F',exact:true}).click();await page.getByRole('button',{name:/测试面馆 测试餐饮/}).click();await page.getByText('测试牛肉面',{exact:true}).waitFor();
  await page.screenshot({path:`/tmp/shumap-desktop-dining-${width}.png`});
  await page.goto(`${origin}/places/place_baoshan_4th-canteen/floors?floor=stg_dining_20260926_floor_0_1&view=plan`);await page.getByRole('region',{name:/平面图/}).waitFor();const pane=page.getByTestId('floor-plan-pane');const img=pane.locator('img');await img.waitFor();await page.waitForFunction(()=>{const i=document.querySelector('[data-testid="floor-plan-pane"] img');return i&&i.complete&&i.naturalWidth>0;});
  const planBox=await pane.boundingBox();if(planBox.width<250||planBox.height<300||planBox.x+planBox.width>width)throw Error('plan size '+JSON.stringify(planBox));
  if(width>=1024){const listBox=await page.getByTestId('floor-facility-pane').boundingBox();if(listBox.x<planBox.x+planBox.width-1)throw Error('not side by side');}
  await pane.getByRole('button',{name:'放大',exact:true}).click();if(!(await img.getAttribute('style')).includes('scale(1.25)'))throw Error('zoom failed');
  await pane.getByRole('button',{name:'适应窗口',exact:true}).click();if(!(await img.getAttribute('style')).includes('scale(1)'))throw Error('fit failed');
  const region=page.getByRole('region',{name:/平面图/});await region.focus();await page.keyboard.press('+');await page.keyboard.press('0');if(!(await img.getAttribute('style')).includes('scale(1)'))throw Error('keyboard reset');
  await page.screenshot({path:`/tmp/shumap-desktop-floors-${width}.png`});
  await page.getByRole('button',{name:'2层餐厅（测试）',exact:true}).click();await pane.waitFor({state:'hidden'});await page.getByText('该楼层暂无设施信息',{exact:true}).waitFor();
  checks.push(width+'px dining + plan/list + zoom + no-plan fallback');
 }
 await page.setViewportSize({width:390,height:844});await page.goto(`${origin}/shuttle`);await page.getByRole('button',{name:'你觉得校车查询好用吗？',exact:true}).click();if(await page.locator('dialog').count())throw Error('desktop dialog on mobile');await page.getByRole('button',{name:'1 星',exact:true}).waitFor();await page.keyboard.press('Escape');checks.push('mobile rating unchanged');
 await page.evaluate(saved=>{if(saved===null)localStorage.removeItem('shumap.feature-feedback');else localStorage.setItem('shumap.feature-feedback',saved);},savedFeedback);
 if(errors.length)throw Error(errors.join(';'));return {checks,errors};
}
